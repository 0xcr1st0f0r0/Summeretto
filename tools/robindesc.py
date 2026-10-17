#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
robindesc.py —— 从 gRPC 描述符注册表类提取「RPC 名 → 请求/响应消息类」全表。

原理：每个 RPC 的注册代码形如
    Lharw b = Lhasb.e();
    b.d = Lhasb.d("assistant.mobile.robin.RobinService", "<RpcName>");
    b.a = new Lhboh(<ReqMsg>.a);     // 请求 marshaller
    b.b = new Lhboh(<RespMsg>.a);    // 响应 marshaller
    <某静态字段> = b.a();
所以只需依次跟踪：RPC 名字符串 → 紧跟的 sget-object 消息默认实例 → Lhboh.<init>。

用法:
  python tools/robindesc.py apk/AGSA_17.66.12.xapk --class "^Lgbdm;$"
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
from codeitem import CodeItem, insn_size, OP_CONST_STRING, OP_CONST_STRING_JUMBO  # noqa


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


def analyze(dex, coff, want_rpc_prefix=None):
    """按寄存器跟踪：sget-object 载入的消息默认实例 → 传给 Lhboh.<init> 的那个寄存器。

    典型字节码：
      sget-object v3, LX;->a:LX;           ← 请求消息默认实例
      sget-object v4, Lhboj;->a:LERL;      ← 干扰项（另一寄存器）
      new-instance v4, Lhboh;
      invoke-direct {v4,v3}, Lhboh.<init>(Lcom/google/protobuf/MessageLite;)V
    """
    ins = CodeItem(dex.d, coff, dex).insns
    p = 0
    out = {"rpc": None, "msgs": []}
    regs = {}
    n = len(ins)
    while p + 2 <= n:
        op = ins[p]
        if op == OP_CONST_STRING:
            idx = struct.unpack_from("<H", ins, p + 2)[0]
            s = dex.strings[idx] if idx < len(dex.strings) else ""
            if out["rpc"] is None and s and len(s) < 60 \
                    and not s.startswith(("assistant.mobile.robin", "java", "kotlin", "com.")):
                if s[:1].isupper() and " " not in s:
                    out["rpc"] = s
            p += 4
        elif op == OP_CONST_STRING_JUMBO:
            p += 6
        elif 0x60 <= op <= 0x6D:               # sget*/sput* (21c)
            fi = struct.unpack_from("<H", ins, p + 2)[0]
            reg = ins[p + 1]
            if fi < len(dex.field_ids):
                fc, ft, fn = dex.field_ids[fi]
                if op in (0x62, 0x60) and fn == "a" and ft.endswith(";"):
                    regs[reg] = ft
            p += 4
        elif op == 0x22:                       # new-instance (21c)
            ti = struct.unpack_from("<H", ins, p + 2)[0]
            reg = ins[p + 1]
            regs[reg] = dex.type_ids[ti] if ti < len(dex.type_ids) else "?"
            p += 4
        elif 0x6E <= op <= 0x72 or 0x74 <= op <= 0x78:
            mi = struct.unpack_from("<H", ins, p + 2)[0]
            if mi < len(dex.method_ids):
                mc, mn = dex.method_ids[mi]
                if mn == "<init>" and mc == "Lhboh;":
                    # 取实参寄存器：35c = {C,D,...}
                    w0 = struct.unpack_from("<H", ins, p)[0]
                    cnt = (w0 >> 12) & 0xF
                    b4 = ins[p + 4]
                    b5 = ins[p + 5]
                    rl = [b4 & 0xF, b4 >> 4, b5 & 0xF, b5 >> 4]
                    if cnt == 5:
                        rl = rl + [(w0 >> 8) & 0xF]
                    else:
                        rl = rl[:cnt]
                    if len(rl) >= 2:
                        t = regs.get(rl[1])
                        if t:
                            out["msgs"].append(t)
            p += 6
        else:
            p += insn_size(ins, p)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--class", dest="cls", required=True)
    a = ap.parse_args()
    rx = re.compile(a.cls)

    total = 0
    for dn, dex in load_all(a.path):
        for ci, cdesc in enumerate(dex.class_defs):
            if not rx.search(cdesc):
                continue
            cd = dex.iter_class_data(ci)
            if not cd:
                continue
            print(f"\n########## [{dn}] {cdesc} ({len(cd[0]+cd[1])} 个方法)")
            for (midx, acc, coff) in cd[0] + cd[1]:
                if not coff:
                    continue
                r = analyze(dex, coff)
                if not r["rpc"] and not r["msgs"]:
                    continue
                total += 1
                req = r["msgs"][0] if len(r["msgs"]) > 0 else "?"
                resp = r["msgs"][1] if len(r["msgs"]) > 1 else "?"
                print(f"  {dex.method_ids[midx][1]:>6s}  {str(r['rpc']):<45s} "
                      f"req={req:<10s} resp={resp}")
    print(f"\n[+] 共 {total} 条")
    return 0


if __name__ == "__main__":
    sys.exit(main())
