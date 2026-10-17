#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
xref.py —— 字符串交叉引用扫描：找出「哪个类.哪个方法引用了哪些字符串」。

为什么需要它：字符串池只知道「存在」，不知道「谁用」。反推协议时要追
"robinfrontend-pa 这个主机名哪个类在用"这类问题，必须做字节码级 xref。

性能设计（教训见 codeitem.py 的 parse_tries 注释）：
  * insns 直接内联读（不构造 CodeItem 对象、不解析 tries）
  * C 级 bytes.find 搜 const-string 模式：`1A ?? lo hi` / `1B ?? lo hi hi hi`
  * 命中才做完整解码（verify / --show）

用法:
  python tools/xref.py apk/AGSA_17.66.12.xapk --strs "robinfrontend-pa"
  python tools/xref.py apk/AGSA_17.66.12.xapk --strs "a,b" --dex classes2.dex,classes4.dex
  python tools/xref.py apk/AGSA_17.66.12.xapk --strs "SendClientInput" --show
"""
import argparse
import io
import os
import re
import struct
import sys
import time
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dexlib import DexFile  # noqa
from codeitem import CodeItem, decode_method  # noqa


def load_dexes(path, only=None):
    out = []
    z = zipfile.ZipFile(path)
    entries = z.namelist()
    inner_apks = [n for n in entries if n.lower().endswith(".apk")]
    if inner_apks:
        for iname in inner_apks:
            inner = zipfile.ZipFile(io.BytesIO(z.read(iname)))
            for dn in sorted(n for n in inner.namelist() if re.match(r"^classes\d*\.dex$", n)):
                if only and dn not in only:
                    continue
                out.append((iname, dn, DexFile(inner.read(dn), dn)))
            inner.close()
    else:
        for dn in sorted(n for n in entries if re.match(r"^classes\d*\.dex$", n)):
            if only and dn not in only:
                continue
            out.append((os.path.basename(path), dn, DexFile(z.read(dn), dn)))
    z.close()
    return out


def insns_at(data, off):
    """内联读 CodeItem 的 insns（不建对象）。CodeItem 头:
    u16*4 (regs/ins/outs/tries) + u32 debug + u32 insns_size"""
    insns_size = struct.unpack_from("<I", data, off + 12)[0]
    base = off + 16
    return data[base:base + insns_size * 2]


def scan_insns(ins, lo_set):
    """在 insns 里找 const-string(/jumbo) 命中 lo_set（{low16: [labels]}）。"""
    hits = None
    n = len(ins)
    # const-string: 1A reg lo hi  (4 字节)
    p = ins.find(b"\x1a")
    while 0 <= p and p + 4 <= n:
        labels = lo_set.get(ins[p + 2] | (ins[p + 3] << 8))
        if labels:
            if hits is None:
                hits = set()
            hits.update(labels)
        p = ins.find(b"\x1a", p + 1)
    # const-string/jumbo: 1B reg lo hi b3 b4 (6 字节)
    p = ins.find(b"\x1b")
    while 0 <= p and p + 6 <= n:
        if ins[p + 4] == 0 and ins[p + 5] == 0:
            labels = lo_set.get(ins[p + 2] | (ins[p + 3] << 8))
            if labels:
                if hits is None:
                    hits = set()
                hits.update(labels)
        p = ins.find(b"\x1b", p + 1)
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--strs", required=True, help="目标字符串（子串匹配），逗号分隔")
    ap.add_argument("--dex", default=None, help="限制 dex，逗号分隔")
    ap.add_argument("--class", dest="cls", default=None, help="类名正则（进一步限制）")
    ap.add_argument("--show", action="store_true", help="命中方法完整解码，打印字符串/invoke")
    ap.add_argument("--full", action="store_true", help="配合 --show：打印全部字符串")
    ap.add_argument("--limit", type=int, default=120)
    a = ap.parse_args()

    needles = [s for s in a.strs.split(",") if s]
    only = set(a.dex.split(",")) if a.dex else None
    cls_rx = re.compile(a.cls) if a.cls else None

    print(f"[*] 加载 {a.path} ...", flush=True)
    dexes = load_dexes(a.path, only)
    print(f"[*] {len(dexes)} 个 DEX", flush=True)

    total_hits = 0
    for iname, dn, dex in dexes:
        targets = {}
        for i, s in enumerate(dex.strings):
            for nd in needles:
                if nd in s:
                    targets[i] = s[:160]
        if not targets:
            continue
        lo_set = {}
        for sidx, label in targets.items():
            lo_set.setdefault(sidx & 0xFFFF, []).append(label)

        print(f"\n### {dn}  目标字符串 {len(set(targets.values()))} 条 ###", flush=True)
        for t in sorted(set(targets.values()))[:10]:
            print(f"    - {t}")
        if len(set(targets.values())) > 10:
            print(f"    ...（共 {len(set(targets.values()))} 条唯一）")

        t0 = time.time()
        dex_hits = 0
        for ci, cdesc in enumerate(dex.class_defs):
            if cls_rx and not cls_rx.search(cdesc):
                continue
            cd = dex.iter_class_data(ci)
            if not cd:
                continue
            direct, virtual = cd
            for (midx, acc, coff) in direct + virtual:
                if coff == 0:
                    continue
                try:
                    ins = insns_at(dex.d, coff)
                except Exception:
                    continue
                hits = scan_insns(ins, lo_set)
                if not hits:
                    continue
                mname = dex.method_ids[midx][1] if midx < len(dex.method_ids) else "?"
                short = cdesc.split("/")[-1].rstrip(";")
                # 验证：只对少量命中做完整解码（去误报）
                real = hits
                if not a.show:
                    try:
                        mb = decode_method(dex, cdesc, mname, CodeItem(dex.d, coff, dex))
                        real = {h for h in hits if h and any(h in s2 for s2 in mb.strings)}
                    except Exception:
                        real = hits
                    if not real:
                        continue
                verify = None
                if a.show:
                    try:
                        verify = decode_method(dex, cdesc, mname, CodeItem(dex.d, coff, dex))
                    except Exception:
                        verify = None
                dex_hits += 1
                total_hits += 1
                if total_hits > a.limit:
                    print(f"[!] 超过 --limit {a.limit}，停止")
                    return 0
                print(f"\n  [{dn}] {short}.{mname}")
                for h in sorted(real):
                    print(f"      >> {h}")
                if a.show and verify is not None:
                    mb = verify
                    strs = mb.strings if a.full else [s for s in mb.strings
                                                      if any(h in s for h in real)]
                    seen = set()
                    for s in strs[:40]:
                        if s in seen:
                            continue
                        seen.add(s)
                        print(f"         str  {s[:150]}")
                    if mb.methods:
                        seenm = set()
                        print(f"         invoke x{len(mb.methods)}:")
                        for mc, mn in mb.methods[:30]:
                            key = (mc, mn)
                            if key in seenm:
                                continue
                            seenm.add(key)
                            print(f"            -> {mc.split('/')[-1].rstrip(';')}.{mn}")
                    if mb.const_calls:
                        print(f"         const→call x{len(mb.const_calls)}:")
                        for mc, mn, cv in mb.const_calls[:40]:
                            print(f"            #{cv} {mc.split('/')[-1].rstrip(';')}.{mn}")
                    if mb.fields:
                        print(f"         field x{len(mb.fields)}:")
                        for fc, ft, fn in mb.fields[:20]:
                            print(f"            :: {fc.split('/')[-1].rstrip(';')}.{fn} : {ft}")
                    if mb.types:
                        print(f"         types: {[t.split('/')[-1] for t in mb.types[:15]]}")
        print(f"  -- {dn}: {dex_hits} 个方法命中，耗时 {time.time()-t0:.1f}s", flush=True)

    print(f"\n[+] 合计 {total_hits} 个方法命中")
    return 0


if __name__ == "__main__":
    sys.exit(main())
