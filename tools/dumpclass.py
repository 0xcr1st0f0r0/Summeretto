#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dumpclass.py —— 按类名正则完整转储方法级信息。

比 xref.py 更直接：不需要目标字符串，直接给出「某类/某包下所有类」的
方法 → 字符串 / invoke / const→call / 字段 / 类型。

用法:
  python tools/dumpclass.py apk/AGSA_17.66.12.xapk --class "^Lanue;$"
  python tools/dumpclass.py apk/AGSA_17.66.12.xapk --class "^Lanu[a-z];$" --brief
  python tools/dumpclass.py apk/AGSA_17.66.12.xapk --class "^Lanue;$" --dex classes12.dex
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


def short(d):
    return d.split("/")[-1].rstrip(";")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--class", dest="cls", required=True, help="类名正则（对完整描述符）")
    ap.add_argument("--dex", default=None, help="限制 dex，逗号分隔")
    ap.add_argument("--brief", action="store_true", help="只列方法名与字符串计数")
    ap.add_argument("--no-const", action="store_true", help="不打印 const→call")
    ap.add_argument("--maxstr", type=int, default=60)
    a = ap.parse_args()

    cls_rx = re.compile(a.cls)
    only = set(a.dex.split(",")) if a.dex else None
    dexes = load_dexes(a.path, only)
    print(f"[*] {len(dexes)} DEX")

    for iname, dn, dex in dexes:
        for ci, cdesc in enumerate(dex.class_defs):
            if not cls_rx.search(cdesc):
                continue
            # 类头信息
            hdr = dex.class_headers.get(ci) if hasattr(dex, "class_headers") else None
            print(f"\n########## [{dn}] {cdesc}")
            print(f"    super={dex.class_supers[ci]}  ifaces={list(dex.class_ifaces[ci])}")
            cd = dex.iter_class_data(ci)
            if not cd:
                print("    (无 class_data)")
                continue
            direct, virtual = cd
            for tag, group in (("direct", direct), ("virtual", virtual)):
                for (midx, acc, coff) in group:
                    mname = dex.method_ids[midx][1] if midx < len(dex.method_ids) else "?"
                    msig = dex.msig(midx)
                    if a.brief:
                        print(f"    [{tag}] acc=0x{acc:x} code={'Y' if coff else '-'}  {msig}")
                        continue
                    if coff == 0:
                        print(f"    [{tag}] {msig} acc=0x{acc:x} (abstract/native)")
                        continue
                    try:
                        mb = decode_method(dex, cdesc, mname, CodeItem(dex.d, coff, dex))
                    except Exception as e:
                        print(f"    [{tag}] {msig} 解码失败: {e}")
                        continue
                    print(f"    [{tag}] {msig} acc=0x{acc:x} strs={len(mb.strings)} "
                          f"inv={len(mb.methods)} fld={len(mb.fields)}")
                    seen = set()
                    for s in mb.strings[: a.maxstr]:
                        if s in seen:
                            continue
                        seen.add(s)
                        print(f"         str  {s[:170]}")
                    seenm = set()
                    for mc, mn in mb.methods:
                        k = (mc, mn)
                        if k in seenm:
                            continue
                        seenm.add(k)
                        print(f"         ->   {short(mc)}.{mn}")
                    if not a.no_const and mb.const_calls:
                        for mc, mn, cv in mb.const_calls[:40]:
                            print(f"         #    #{cv} {short(mc)}.{mn}")
                    seend = set()
                    for fc, ft, fn in mb.fields:
                        k = (fn, ft)
                        if k in seend:
                            continue
                        seend.add(k)
                        print(f"         ::   {short(fc)}.{fn} : {ft}")
                    if mb.types:
                        print(f"         ty   {[short(t) for t in dict.fromkeys(mb.types)]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
