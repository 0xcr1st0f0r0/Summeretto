#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dump_strings.py —— 全量字符串/类名转储（带 dex 归属），供任意关键词检索。

背景：每次用 DexFile 解析 245MB XAPK 都要几十秒~几分钟，反复做不划算。
本工具一次性把所有 DEX 的字符串池与类名落盘，之后用 grep 即可秒查。

用法:
    python tools/dump_strings.py apk/AGSA_17.66.12.xapk --out out/idx
    python tools/dump_strings.py apk/AGSA_17.66.12.xapk --out out/idx --dex classes4.dex
"""
import argparse
import io
import json
import os
import re
import sys
import time
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dexlib import DexFile  # noqa


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--out", default="out/idx")
    ap.add_argument("--dex", default=None, help="只处理指定 dex（逗号分隔），默认全部")
    a = ap.parse_args()

    want = set(x.strip() for x in a.dex.split(",")) if a.dex else None
    os.makedirs(a.out, exist_ok=True)

    z = zipfile.ZipFile(a.path)
    manifest_path = os.path.join(a.out, "manifest.json")
    manifest = {}
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)

    inner_names = [n for n in z.namelist() if n.lower().endswith(".apk")]
    for iname in inner_names:
        inner = zipfile.ZipFile(io.BytesIO(z.read(iname)))
        dexnames = sorted(n for n in inner.namelist() if re.match(r"^classes\d*\.dex$", n))
        for dn in dexnames:
            if want and dn not in want:
                continue
            t0 = time.time()
            raw = inner.read(dn)
            dex = DexFile(raw, dn)
            t1 = time.time()
            base = re.sub(r"[^\w.]", "_", os.path.basename(iname)) + "." + dn
            sp = os.path.join(a.out, base + ".strings.txt")
            cp = os.path.join(a.out, base + ".classes.txt")
            with open(sp, "w", encoding="utf-8") as f:
                for s in dex.strings:
                    # 换行会破坏 grep 一行一条的约定，转义
                    f.write(s.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r") + "\n")
            with open(cp, "w", encoding="utf-8") as f:
                for c in dex.class_defs:
                    f.write(c + "\n")
            manifest[f"{iname}!{dn}"] = {
                "strings": os.path.relpath(sp, a.out).replace("\\", "/"),
                "classes": os.path.relpath(cp, a.out).replace("\\", "/"),
                "n_strings": len(dex.strings),
                "n_classes": len(dex.class_defs),
                "dex_bytes": len(raw),
            }
            with open(manifest_path, "w", encoding="utf-8") as f:
                json.dump(manifest, f, indent=1, ensure_ascii=False)
            print(f"[dump] {dn:16} str={len(dex.strings):7} cls={len(dex.class_defs):6} "
                  f"parse={t1 - t0:5.1f}s -> {os.path.basename(sp)}", flush=True)
        inner.close()
    z.close()
    print(f"[+] manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
