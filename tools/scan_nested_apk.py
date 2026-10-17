#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scan_nested_apk.py —— 直接从 XAPK/APKS 内嵌 APK 流式扫描（不解包到磁盘）

大APK（AGSA 245MB）解包会吃磁盘，本工具用zipfile 逐个 entry 读入内存，
DexFile 支持 bytes 输入，全程零落盘。

用法:
    python tools/scan_nested_apk.py <xapk路径> [--out out/agsa-scan] [--only base]
"""
import io
import json
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dexlib import DexFile, scan, DEFAULT_PATTERNS, RE_GRPC_METHOD, RE_URL  # noqa


def iter_inner_apks(path):
    """产出 (内部条目名, bytes, size)"""
    z = zipfile.ZipFile(path)
    for i in z.infolist():
        if i.filename.lower().endswith(".apk"):
            yield i.filename, z.read(i.filename), i.file_size
    z.close()


def scan_one(name, data, out, verbose=True):
    import zipfile as zf
    lines = []
    io_ = zf.ZipFile(io.BytesIO(data))
    dexnames = sorted(n for n in io_.namelist() if re.match(r"^classes\d*\.dex$", n))
    if not dexnames:
        lines.append(f"--- {name}: 无 DEX ---")
        return []
    lines.append(f"--- {name}  ({len(data)/1024/1024:.1f}MB, {len(dexnames)} DEX) ---")
    dexes = []
    for dn in dexnames:
        try:
            d = DexFile(io_.read(dn), dn)
            dexes.append(d)
            if verbose:
                print(f"   [dex] {dn:16} {len(io_.read(dn))/1024/1024:7.2f}MB "
                      f"str={len(d.strings):7} typ={len(d.type_ids):6} "
                      f"mth={len(d.method_ids):7} cls={len(d.class_defs):6}")
        except Exception as e:
            lines.append(f"   [dex] {dn} 解析失败: {e}")

    # native .so 里的字符串（AGSA 可能把端点藏在 so 里）
    so_names = [n for n in io_.namelist() if n.endswith(".so")]
    if so_names:
        lines.append(f"   [so] {len(so_names)} 个 native 库,最大 {max(io_.getinfo(n).file_size for n in so_names)/1024/1024:.1f}MB")

    if not dexes:
        return lines

    res = scan(dexes, DEFAULT_PATTERNS)
    lines.append("")
    for rule in DEFAULT_PATTERNS:
        seen = {}
        for s, dexn, tags in res.get(rule, []):
            seen.setdefault(s, (dexn, tags))
        lines.append(f"  === {rule}: {len(seen)} ===")
        if seen:
            fp = os.path.join(out, f"{name.replace('.apk','')}.{rule}.txt")
            with open(fp, "w", encoding="utf-8") as f:
                for s, (dexn, tags) in sorted(seen.items()):
                    f.write(f"{s}\t{dexn}\t{tags}\n")
            for s, (dexn, tags) in sorted(seen.items())[:50]:
                lines.append(f"    [{tags:16}] {s[:140]}")
            if len(seen) > 50:
                lines.append(f"    ...另 {len(seen)-50} 条 → {os.path.basename(fp)}")
        lines.append("")

    # 汇总导出
    allstr = [s for d in dexes for s in d.strings]
    for label, pred in [
        ("urls", lambda s: s.startswith(("http://", "https://", "wss://", "grpc://"))),
        ("grpc", lambda s: RE_GRPC_METHOD.match(s)),
        ("mimes", lambda s: re.match(r"^(video|audio|image|application)/[\w.+-]+$", s)),
        ("paths", lambda s: RE_URL.match(s) and "/" in s[1:]),
    ]:
        vals = sorted({s for s in allstr if pred(s)})
        fp = os.path.join(out, f"{name.replace('.apk','')}.{label}.txt")
        with open(fp, "w", encoding="utf-8") as f:
            for s in vals:
                f.write(s + "\n")
        lines.append(f"  导出 {label}: {len(vals)} 条 → {os.path.basename(fp)}")

    # 类名
    cls = sorted({c for d in dexes for c in d.class_defs})
    fp = os.path.join(out, f"{name.replace('.apk','')}.classes.txt")
    with open(fp, "w", encoding="utf-8") as f:
        for c in cls:
            f.write(c + "\n")
    lines.append(f"  导出 classes: {len(cls)} 条 → {os.path.basename(fp)}")
    lines.append("")
    return lines


def main():
    if len(sys.argv) < 2:
        print("用法: python scan_nested_apk.py <xapk> [--out DIR]")
        return 1
    path = sys.argv[1]
    out = "out/agsa-scan"
    if "--out" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1]
    only = None
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1]
    os.makedirs(out, exist_ok=True)

    all_lines = [f"XAPK: {path}", f"out: {out}", ""]
    total_str = 0
    for name, data, size in iter_inner_apks(path):
        # 排除 config.* 资源分包（无 DEX）
        if re.match(r"^config\.", os.path.basename(name)):
            continue
        if only and only not in os.path.basename(name) and only != name:
            continue
        print(f"\n>>> 扫描 {name} ({size/1024/1024:.1f}MB)")
        ls = scan_one(name, data, out)
        all_lines.extend(ls or [])

    with open(os.path.join(out, "summary.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(all_lines))
    print("\n" + "=" * 60)
    print("\n".join(all_lines[-40:]))
    print(f"\n[+] 输出: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())