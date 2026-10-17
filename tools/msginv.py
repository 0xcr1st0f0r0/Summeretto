#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
msginv.py —— protobuf 消息清单：列出所有消息类的「声明字段」。

识别方法：类实现了 dynamicMethod(Lgoeo;Ljava/lang/Object;Ljava/lang/Object;)
          且继承 GeneratedMessageLite 体系（Lgoep / Lgoek）。
输出：每条消息的字段数、静态字段（默认实例/嵌套默认实例）、实例字段类型。

用法:
  python tools/msginv.py apk/AGSA_17.66.12.xapk --minfields 8
  python tools/msginv.py apk/... --class "^Lgcv" --show
  python tools/msginv.py apk/... --typecount          # 统计字段类型分布
"""
import argparse
import io
import os
import re
import sys
import zipfile
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dexlib import DexFile  # noqa

DYN = re.compile(r"^dynamicMethod\(Lgoeo;")


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
    ap.add_argument("--class", dest="cls", default=None, help="类名正则过滤")
    ap.add_argument("--minfields", type=int, default=0)
    ap.add_argument("--typecount", action="store_true")
    ap.add_argument("--show", action="store_true", help="打印字段明细")
    a = ap.parse_args()
    rx = re.compile(a.cls) if a.cls else None

    msgs = []      # (dex, cls, ci, sf, inf)
    tc = Counter()
    for dn, dex in load_all(a.path):
        for ci, cdesc in enumerate(dex.class_defs):
            if rx and not rx.search(cdesc):
                continue
            sup = dex.class_supers[ci]
            if sup not in ("Lgoek;", "Lgoep;", "Lgoeh;", "Lhary;"):
                continue
            cd = dex.iter_class_data(ci)
            if not cd:
                continue
            names = [dex.method_ids[m][1] for (m, _a, _c) in cd[0] + cd[1]
                     if ".dynamicMethod(Lgoeo;" in dex.msig(m)]
            if not names:
                continue
            sf, inf = dex.class_fields(ci)
            # 排除 memoized byte 字段
            real = [f for f in inf if not (f[1] == "B" and f[2] == "g" or f[1] == "B")]
            msgs.append((dn, cdesc, ci, sup, sf, real))
            for f in real:
                tc[f[1]] += 1

    print(f"[*] 共 {len(msgs)} 个 protobuf 消息类")
    if a.typecount:
        print("\n字段类型分布（top 40）:")
        for t, n in tc.most_common(40):
            print(f"   {n:6d}  {t}")
    print()
    for (dn, cdesc, ci, sup, sf, real) in sorted(msgs, key=lambda x: -len(x[5])):
        if len(real) < a.minfields:
            continue
        print(f"[{dn}] {cdesc}  extends {sup}  字段={len(real)} 静态={len(sf)}")
        if a.show:
            for (c, t, n, acc) in sf:
                print(f"      static {n} : {t}")
            for (c, t, n, acc) in real:
                print(f"      {n} : {t}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
