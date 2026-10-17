#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
stage2_context.py —— 阶段2：字节码级方法上下文提取

用途：把全局字符串池还原成「哪个类.哪个方法引用了哪些字符串」，
这是反推 payload 构造的关键。

用法:
    # 列出匹配某关键词的类/方法及其字符串引用
    python tools/stage2_context.py <apk|xapk> --grep "PushPayloadType" --limit 40

    # 提取某类的所有方法
    python tools/stage2_context.py <apk> --class "PendingAttachment"
"""
import argparse
import io
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dexlib import DexFile  # noqa
from codeitem import CodeItem, decode_method  # noqa


def load_dexes_from(path):
    """支持 .apk / .xapk(含内层apk)"""
    out = []
    if path.lower().endswith((".xapk", ".apks", ".apkm")):
        z = zipfile.ZipFile(path)
        for i in z.infolist():
            if i.filename.lower().endswith(".apk") and not i.filename.startswith("config."):
                inner = zipfile.ZipFile(io.BytesIO(z.read(i.filename)))
                for dn in sorted(n for n in inner.namelist() if re.match(r"^classes\d*\.dex$", n)):
                    out.append(DexFile(inner.read(dn), dn))
                inner.close()
        z.close()
    else:
        z = zipfile.ZipFile(path)
        for dn in sorted(n for n in z.namelist() if re.match(r"^classes\d*\.dex$", n)):
            out.append(DexFile(z.read(dn), dn))
        z.close()
    return out


def iter_methods_with_code(dex, cls_filter=None):
    """
    产出 (class_desc, method_name, CodeItem)，只遍历有 code 的方法。
    cls_filter: 预编译的正则，先按类名过滤，避免解码无关类（性能关键）。
    """
    import struct
    for ci, cdesc in enumerate(dex.class_defs):
        # ★ 性能短路：先按类名过滤，再解class_data
        if cls_filter is not None and not cls_filter.search(cdesc):
            continue
        cd = dex.iter_class_data(ci)
        if not cd:
            continue
        direct, virtual = cd
        for (midx, acc, coff) in direct + virtual:
            if coff == 0:
                continue
            mname = dex.method_ids[midx][1] if midx < len(dex.method_ids) else "?"
            try:
                code = CodeItem(dex.d, coff, dex)
                yield cdesc, mname, code
            except Exception:
                continue


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--grep", default=None, help="字符串关键词（区分大小写不敏感）")
    ap.add_argument("--class", dest="cls", default=None, help="类名正则")
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--minstrings", type=int, default=1, help="方法至少含多少个字符串引用")
    ap.add_argument("--show", action="store_true", help="打印方法内字符串列表")
    a = ap.parse_args()

    print(f"[*] 加载 {a.path}")
    dexes = load_dexes_from(a.path)
    print(f"[*] {len(dexes)} DEX")

    # ★ 关键优化：给定 --grep 时，先用全局字符串池反查出候选类，
    #   只对这些类做字节码解码 —— 避免遍历 15 万个类。
    g = a.grep.lower() if a.grep else None
    cls_rx = re.compile(a.cls) if a.cls else None
    cand_rx = cls_rx

    if g and cls_rx is None:
        # 第一遍：找出引用了目标字符串的类（用 code_off 直扫 const-string）
        import bisect
        from codeitem import OP_CONST_STRING, OP_CONST_STRING_JUMBO
        cand = set()
        for dex in dexes:
            tidx = set()
            for i, s in enumerate(dex.strings):
                if g in s.lower() and len(s) < 400:
                    tidx.add(i)
            if not tidx:
                continue
            # 扫描所有 code_item 太慢；改用：只对 tidx 非空的 dex 做类级筛选
            # 用启发式：类名含关键词，或该 dex 中 strings 含关键词 → 全部类都要看
            # 更好的做法：直接扫 code_item（下面用快速预筛）
            for ci, cdesc in enumerate(dex.class_defs):
                cd = dex.iter_class_data(ci)
                if not cd:
                    continue
                direct, virtual = cd
                for (midx, acc, coff) in direct + virtual:
                    if coff == 0:
                        continue
                    try:
                        code = CodeItem(dex.d, coff, dex)
                    except Exception:
                        continue
                    ins = code.insns
                    p = 0
                    found = False
                    while p + 1 < len(ins):
                        op = ins[p]
                        if op == OP_CONST_STRING:
                            idx = ins[p + 2] | (ins[p + 3] << 8)
                            if idx in tidx:
                                found = True
                                break
                            p += 4
                        elif op == OP_CONST_STRING_JUMBO:
                            idx = struct.unpack_from("<I", ins, p + 2)[0] if p + 6 <= len(ins) else -1
                            if idx in tidx:
                                found = True
                                break
                            p += 6
                        else:
                            from codeitem import _insn_width
                            w = _insn_width(op)
                            p += w if w else 2
                    if found:
                        cand.add(cdesc)
        print(f"[*] 预筛出 {len(cand)} 个候选类")
        cand_rx = re.compile("|".join(re.escape(c) for c in cand)) if cand else None
        if cand_rx is None:
            print("[!] 无候选类")
            return 1

    import struct
    hits = 0
    for dex in dexes:
        for cdesc, mname, code in iter_methods_with_code(dex, cls_filter=cand_rx):
            mb = decode_method(dex, cdesc, mname, code)
            if len(mb.strings) < a.minstrings:
                continue
            if g:
                matched = [s for s in mb.strings if g in s.lower()]
                if not matched:
                    continue
            else:
                matched = mb.strings
            hits += 1
            if hits > a.limit:
                print(f"[!] 超过 --limit {a.limit}，停止")
                return 0
            short = cdesc.split("/")[-1][:-1]
            print(f"\n=== {dex.name} :: {short}.{mname} ===")
            print(f"    regs={code.registers_size} strs={len(mb.strings)} "
                  f"invokes={len(mb.methods)} fields={len(mb.fields)} types={len(mb.types)}")
            if a.show or g:
                for s in mb.strings:
                    mark = " >>" if (g and g in s.lower()) else "   "
                    print(f"    {mark} {s[:170]}")
    print(f"\n[+] 共 {hits} 个方法命中")
    return 0


if __name__ == "__main__":
    sys.exit(main())