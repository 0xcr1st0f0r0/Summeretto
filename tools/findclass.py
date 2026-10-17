#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
findclass.py —— 跨 DEX 定位类定义（先定位再反汇编，避免全量扫描）。

用法:
  python tools/findclass.py apk/AGSA_17.66.12.xapk --class "^Lgcvp;$"
  python tools/findclass.py apk/AGSA_17.66.12.xapk --class "^Lgcv[px];$" --brief
"""
import argparse
import io
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dexlib import DexFile  # noqa


def load_all(path):
    out = []
    z = zipfile.ZipFile(path)
    entries = z.namelist()
    inner_apks = [n for n in entries if n.lower().endswith(".apk")]
    if inner_apks:
        for iname in inner_apks:
            inner = zipfile.ZipFile(io.BytesIO(z.read(iname)))
            for dn in sorted(n for n in inner.namelist() if re.match(r"^classes\d*\.dex$", n)):
                out.append((dn, DexFile(inner.read(dn), dn)))
            inner.close()
    else:
        for dn in sorted(n for n in entries if re.match(r"^classes\d*\.dex$", n)):
            out.append((dn, DexFile(z.read(dn), dn)))
    z.close()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--class", dest="cls", required=True)
    ap.add_argument("--brief", action="store_true")
    a = ap.parse_args()
    rx = re.compile(a.cls)
    for dn, dex in load_all(a.path):
        for ci, cdesc in enumerate(dex.class_defs):
            if not rx.search(cdesc):
                continue
            print(f"\n[{dn}] {cdesc}")
            print(f"   super={dex.class_supers[ci]}  ifaces={list(dex.class_ifaces[ci])}")
            if a.brief:
                cd = dex.iter_class_data(ci)
                if cd:
                    for (midx, acc, coff) in cd[0] + cd[1]:
                        print(f"   acc=0x{acc:x} code={'Y' if coff else '-'}  {dex.msig(midx)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
