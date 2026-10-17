#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
stage1_scan.py —— 阶段1：静态端点字符串扫描

用法:
    python tools/stage1_scan.py <apk路径> [--out out/scan]

产出:
    <out>/summary.txt      扫描摘要
    <out>/<规则名>.txt命中字符串（去重，带来源 dex）
    <out>/all_urls.txt     所有 URL / 路径
    <out>/grpc.txt         所有 gRPC full-method-name
    <out>/mime.txt         所有 mime type
    <out>/classes.txt      所有类描述符
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dexlib import load_dexes, scan, DEFAULT_PATTERNS, RE_GRPC_METHOD, RE_URL  # noqa


def main():
    if len(sys.argv) < 2:
        print("用法: python stage1_scan.py <apk> [--out DIR]")
        return 1
    apk = sys.argv[1]
    out = "out/scan"
    if "--out" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1]
    os.makedirs(out, exist_ok=True)

    print(f"[*] 加载 {apk}")
    dexes = load_dexes(apk)
    if not dexes:
        print("[!] 没有可用 DEX")
        return 2

    print(f"[*] 扫描 {sum(len(d.strings) for d in dexes)} 条字符串 ...")
    res = scan(dexes, DEFAULT_PATTERNS)

    lines = []
    lines.append(f"APK: {apk}")
    lines.append(f"DEX 数: {len(dexes)}")
    lines.append(f"字符串总数: {sum(len(d.strings) for d in dexes)}")
    lines.append(f"类型总数: {sum(len(d.type_ids) for d in dexes)}")
    lines.append(f"方法总数: {sum(len(d.method_ids) for d in dexes)}")
    lines.append(f"类定义总数: {sum(len(d.class_defs) for d in dexes)}")
    lines.append("")

    for name in DEFAULT_PATTERNS:
        hits = res.get(name, [])
        # 去重
        seen = {}
        for s, dexn, tags in hits:
            if s not in seen:
                seen[s] = (dexn, tags)
        lines.append(f"=== {name}: {len(seen)} 命中 ===")
        with open(os.path.join(out, f"{name}.txt"), "w", encoding="utf-8") as f:
            for s, (dexn, tags) in sorted(seen.items()):
                f.write(f"{s}\t{dexn}\t{tags}\n")
        for s, (dexn, tags) in sorted(seen.items())[:60]:
            lines.append(f"  [{tags:18}] {s[:150]}")
        if len(seen) > 60:
            lines.append(f"  ... 另 {len(seen)-60} 条（见 {name}.txt）")
        lines.append("")

    # 专用导出
    all_strings = []
    for d in dexes:
        all_strings.extend(d.strings)

    urls = sorted({s for s in all_strings
                   if s.startswith(("http://", "https://", "ws://", "wss://", "grpc://"))})
    with open(os.path.join(out, "all_urls.txt"), "w", encoding="utf-8") as f:
        for s in urls:
            f.write(s + "\n")

    grpc = sorted({s for s in all_strings if RE_GRPC_METHOD.match(s)})
    with open(os.path.join(out, "grpc.txt"), "w", encoding="utf-8") as f:
        for s in grpc:
            f.write(s + "\n")

    paths = sorted({s for s in all_strings if RE_URL.match(s) and "/" in s[1:]})
    with open(os.path.join(out, "all_paths.txt"), "w", encoding="utf-8") as f:
        for s in paths:
            f.write(s + "\n")

    mimes = sorted({s for s in all_strings if re.match(r"^(video|audio|image|application)/[\w.+-]+$", s)})
    with open(os.path.join(out, "mime.txt"), "w", encoding="utf-8") as f:
        for s in mimes:
            f.write(s + "\n")

    classes = sorted({s for d in dexes for s in d.class_defs})
    with open(os.path.join(out, "classes.txt"), "w", encoding="utf-8") as f:
        for s in classes:
            f.write(s + "\n")

    lines.append("=== 导出文件 ===")
    for fn in sorted(os.listdir(out)):
        p = os.path.join(out, fn)
        lines.append(f"  {fn:24} {os.path.getsize(p):8} bytes  ({sum(1 for _ in open(p, encoding='utf-8'))} 行)")

    summary = "\n".join(lines)
    with open(os.path.join(out, "summary.txt"), "w", encoding="utf-8") as f:
        f.write(summary)
    print(summary)
    print(f"\n[+] 输出目录: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())