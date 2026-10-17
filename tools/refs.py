#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
refs.py —— 按「类型 / 字段 / 方法」反查引用点（字节码级 xref）。

区别于 xref.py（按字符串找引用者），本工具按 类型索引/字段索引/方法索引 找引用者。
性能关键：先按 2 字节索引做 C 级 bytes.find，再用 opcode 校验，避免全量指令遍历。

用法:
  python tools/refs.py apk/AGSA_17.66.12.xapk --type "^Lgcvp;$"
  python tools/refs.py apk/AGSA_17.66.12.xapk --field "Lgcvp;->a"
  python tools/refs.py apk/AGSA_17.66.12.xapk --method "Lgcvp;.dynamicMethod"
  python tools/refs.py apk/AGSA_17.66.12.xapk --method "Lgcvp;.dynamicMethod" --dex classes10.dex --show
"""
import argparse
import io
import os
import re
import struct
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dexlib import DexFile  # noqa

# opcode 集合
OPS_TYPE = {0x1C: "const-class", 0x1F: "check-cast", 0x20: "instance-of",
            0x22: "new-instance", 0x23: "new-array", 0x1D: "monitor-enter"}
OPS_FIELD = dict([(o, "iget/iput/sget/sput-0x%02x" % o) for o in range(0x52, 0x6E)])
OPS_METHOD = dict([(o, "invoke-0x%02x" % o) for o in range(0x6E, 0x73)] +
                  [(o, "invoke/range-0x%02x" % o) for o in range(0x74, 0x79)] +
                  [(0xFA, "invoke-polymorphic"), (0xFB, "invoke-polymorphic/range"),
                   (0xFC, "invoke-custom"), (0xFD, "invoke-custom/range")])


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
    insns_size = struct.unpack_from("<I", data, off + 12)[0]
    base = off + 16
    return data[base:base + insns_size * 2]


def scan_for_index(dex, op_map, target_idxs, verify, want_all=False):
    """返回 [(ci, midx, mname, op, idx, offset)]

    ⚠️ 索引是 DEX 局部的，且 bytes.find 会命中随机数据；因此：
      1) 要求 op 位置 2 字节对齐（DEX 指令必然偶地址）
      2) 命中后用 verify(idx) 复核解析出的目标（真值校验）
    """
    hits = []
    pats = sorted({t.to_bytes(2, "little") for t in target_idxs})
    for ci, cdesc in enumerate(dex.class_defs):
        cd = dex.iter_class_data(ci)
        if not cd:
            continue
        for (midx, acc, coff) in cd[0] + cd[1]:
            if coff == 0:
                continue
            try:
                ins = insns_at(dex.d, coff)
            except Exception:
                continue
            for pat in pats:
                p = ins.find(pat)
                while 0 <= p:
                    if p >= 2 and p % 2 == 0 and ins[p - 2] in op_map:
                        idx = pat[0] | (pat[1] << 8)
                        if verify(idx):
                            hits.append((ci, cdesc, midx, ins[p - 2], idx, p - 2))
                            if not want_all:
                                return hits
                    p = ins.find(pat, p + 1)
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--type", dest="ty", default=None, help="类型描述符正则")
    ap.add_argument("--field", dest="fld", default=None, help="字段: 类正则->字段名正则")
    ap.add_argument("--method", dest="mth", default=None, help="方法: 类正则.方法名正则")
    ap.add_argument("--dex", default=None)
    ap.add_argument("--limit", type=int, default=80)
    ap.add_argument("--show", action="store_true", help="命中方法反汇编")
    a = ap.parse_args()

    only = set(a.dex.split(",")) if a.dex else None
    dexes = load_dexes(a.path, only)
    total = 0

    for iname, dn, dex in dexes:
        targets = []      # (idx, label)
        op_map = None
        if a.ty:
            rx = re.compile(a.ty)
            op_map = OPS_TYPE
            for i, t in enumerate(dex.type_ids):
                if rx.search(t):
                    targets.append((i, t))
        elif a.fld:
            # 分隔符优先用 "::"（避免与正则里的 \. 冲突），退回 "->"
            sep = "::" if "::" in a.fld else "->"
            cls_rx_s, name_rx_s = a.fld.split(sep, 1)
            cls_rx = re.compile(cls_rx_s)
            name_rx = re.compile(name_rx_s)
            op_map = OPS_FIELD
            for i, (c, t, n) in enumerate(dex.field_ids):
                if cls_rx.search(c) and name_rx.search(n):
                    targets.append((i, f"{c}->{n}:{t}"))
        elif a.mth:
            cls_rx_s, name_rx_s = (a.mth.split("::", 1) if "::" in a.mth
                                   else a.mth.rsplit(".", 1))
            cls_rx = re.compile(cls_rx_s)
            name_rx = re.compile(name_rx_s)
            op_map = OPS_METHOD
            for i, (c, n) in enumerate(dex.method_ids):
                if cls_rx.search(c) and name_rx.search(n):
                    targets.append((i, dex.msig(i)))
        else:
            print("[!] 需要 --type/--field/--method")
            return 1
        if not targets:
            continue
        labels = {}
        for i, lb in targets:
            labels[i] = lb
        print(f"\n### {dn}: {len(targets)} 个目标 ###")
        for i, lb in targets[:6]:
            print(f"    #{i} {lb}")
        if len(targets) > 6:
            print(f"    ...（共 {len(targets)}）")

        # 真值校验：解析到该 idx 的实际名字必须等于目标
        if a.ty:
            verify = lambda idx: 0 <= idx < len(dex.type_ids) and idx in labels
        elif a.fld:
            verify = lambda idx: 0 <= idx < len(dex.field_ids) and idx in labels
        else:
            verify = lambda idx: 0 <= idx < len(dex.method_ids) and idx in labels

        hits = scan_for_index(dex, op_map, [i for i, _ in targets], verify, want_all=False)
        seen = set()
        for (ci, cdesc, midx, op, idx, off) in hits:
            key = (cdesc, midx)
            if key in seen:
                continue
            seen.add(key)
            total += 1
            if total > a.limit:
                print(f"[!] 超过 --limit {a.limit}")
                return 0
            print(f"\n  [{dn}] {dex.msig(midx)}")
            print(f"      op={op_map[op]} idx=#{idx} ({labels.get(idx)}) @insn+{off}")
            if a.show:
                from disasm import disasm
                from codeitem import CodeItem
                # 找 code item
                cd = dex.iter_class_data(ci)
                for (m2, acc2, co2) in cd[0] + cd[1]:
                    if m2 == midx and co2:
                        code = CodeItem(dex.d, co2, dex)
                        for ln in disasm(dex, code.insns, show_raw=False):
                            print(ln)
                        break
    print(f"\n[+] 合计 {total} 个方法命中")
    return 0


if __name__ == "__main__":
    sys.exit(main())
