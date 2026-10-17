#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
disasm.py —— DEX 线性反汇编（带符号解析）。

用途：dumpclass.py 只给"引用了什么"，disasm 给"按什么顺序、写入哪个字段"。
反推 gRPC 描述符表 / protobuf 字段编号这类「顺序敏感」的东西必须用线性视图。

用法:
  python tools/disasm.py apk/AGSA_17.66.12.xapk --class "^Lgcpe;$" --method clinit
  python tools/disasm.py apk/... --class "^Lgcpe;$" --method clinit --max 400
  python tools/disasm.py apk/... --class "^Lgcpe;$" --method clinit --grep "sput"
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
from codeitem import CodeItem, insn_size  # noqa


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


# 格式分类 → 打印方式
#  10x/12x: op
#  11n: op vA, #+B          (const/4)
#  11x: op vA
#  12x: op vA, vB
#  21c: op vA, ref
#  21h: op vA, #+hi
#  21s: op vA, #+lit
#  22c: op vA, vB, ref
#  22s: op vA, vB, #+lit
#  23x: op vAA, vBB, vCC
#  31i: op vA, #+lit
#  31t: op vA, +off
#  32x: op vAAAA, vBBBB
#  35c: op {vC,vD,vE,vF,vG}, ref
#  3rc: op {vCCCC..vNNNN}, ref
#  51l: op vA, #+lit(wide)
FMT = {}


def _fill():
    F = {}
    # 10x
    for op in [0x00, 0x0E, 0x3E, 0x3F, 0x40, 0x41, 0x42, 0x43, 0x73, 0x79, 0x7A]:
        F[op] = "10x"
    for op in range(0x0A, 0x0E):
        F[op] = "11x"          # move-result / move-exception / return
    F[0x0F] = "11x"; F[0x10] = "11x"; F[0x11] = "11x"
    F[0x12] = "11n"            # const/4
    F[0x1D] = "11x"; F[0x1E] = "11x"
    F[0x27] = "11x"; F[0x28] = "10t"
    F[0x01] = "12x"; F[0x04] = "12x"; F[0x07] = "12x"
    for op in range(0x7B, 0x90):
        F[op] = "12x"
    for op in range(0xB0, 0xD0):
        F[op] = "12x"
    F[0x21] = "12x"            # array-length
    F[0x02] = "22x"; F[0x05] = "22x"; F[0x08] = "22x"   # move/from16 系列
    F[0x20] = "22c"; F[0x23] = "22c"
    for op in range(0x2D, 0x38):
        F[op] = "23x"          # cmpl/cmpg/cmp + if-test（2 寄存器）
    for op in range(0x38, 0x3E):
        F[op] = "21t"          # if-testz：1 寄存器 + 分支偏移
    for op in range(0x44, 0x52):
        F[op] = "23x"          # aget/aput
    F[0x03] = "32x"; F[0x06] = "32x"; F[0x09] = "32x"
    F[0x13] = "21s"; F[0x15] = "21h"; F[0x16] = "21s"; F[0x19] = "21h"
    F[0x14] = "31i"; F[0x17] = "31i"
    F[0x18] = "51l"
    F[0x1A] = "21c"; F[0x1C] = "21c"; F[0x1F] = "21c"; F[0x22] = "21c"
    F[0x1B] = "31c"            # const-string/jumbo
    F[0x24] = "35c"; F[0x25] = "3rc"
    for op in range(0x6E, 0x73):
        F[op] = "35c"
    for op in range(0x74, 0x79):
        F[op] = "3rc"
    F[0x26] = "31t"; F[0x2B] = "31t"; F[0x2C] = "31t"
    F[0x29] = "20t"; F[0x2A] = "30t"
    for op in range(0x90, 0xB0):
        F[op] = "23x"
    for op in range(0x52, 0x6E):
        F[op] = "22c"
    for op in range(0xD0, 0xD8):
        F[op] = "22s"
    for op in range(0xD8, 0xE3):
        F[op] = "22b"
    for op in range(0xE3, 0xFA):
        F[op] = "10x"
    F[0xFA] = "45cc"; F[0xFB] = "4rcc"
    F[0xFC] = "35c"; F[0xFD] = "3rc"
    F[0xFE] = "21c"; F[0xFF] = "21c"
    return F


FMT = _fill()

NAME = {
    0x00: "nop", 0x01: "move", 0x02: "move/from16", 0x03: "move/16",
    0x04: "move-wide", 0x05: "move-wide/from16", 0x06: "move-wide/16",
    0x07: "move-object", 0x08: "move-object/from16", 0x09: "move-object/16",
    0x0A: "move-result", 0x0B: "move-result-wide", 0x0C: "move-result-object",
    0x0D: "move-exception", 0x0E: "return-void", 0x0F: "return",
    0x10: "return-wide", 0x11: "return-object", 0x12: "const/4",
    0x13: "const/16", 0x14: "const", 0x15: "const/high16",
    0x16: "const-wide/16", 0x17: "const-wide/32", 0x18: "const-wide",
    0x19: "const-wide/high16", 0x1A: "const-string", 0x1B: "const-string/jumbo",
    0x1C: "const-class", 0x1D: "monitor-enter", 0x1E: "monitor-exit",
    0x1F: "check-cast", 0x20: "instance-of", 0x21: "array-length",
    0x22: "new-instance", 0x23: "new-array", 0x24: "filled-new-array",
    0x25: "filled-new-array/range", 0x26: "fill-array-data",
    0x27: "throw", 0x28: "goto", 0x29: "goto/16", 0x2A: "goto/32",
    0x2B: "packed-switch", 0x2C: "sparse-switch",
    0x2D: "cmpl-float", 0x2E: "cmpg-float", 0x2F: "cmpl-double",
    0x30: "cmpg-double", 0x31: "cmp-long",
    0x32: "if-eq", 0x33: "if-ne", 0x34: "if-lt", 0x35: "if-ge",
    0x36: "if-gt", 0x37: "if-le",
    0x38: "if-eqz", 0x39: "if-nez", 0x3A: "if-ltz", 0x3B: "if-gez",
    0x3C: "if-gtz", 0x3D: "if-lez",
    0x44: "aget", 0x45: "aget-wide", 0x46: "aget-object", 0x47: "aget-boolean",
    0x48: "aget-byte", 0x49: "aget-char", 0x4A: "aget-short",
    0x4B: "aput", 0x4C: "aput-wide", 0x4D: "aput-object", 0x4E: "aput-boolean",
    0x4F: "aput-byte", 0x50: "aput-char", 0x51: "aput-short",
    0x52: "iget", 0x53: "iget-wide", 0x54: "iget-object", 0x55: "iget-boolean",
    0x56: "iget-byte", 0x57: "iget-char", 0x58: "iget-short",
    0x59: "iput", 0x5A: "iput-wide", 0x5B: "iput-object", 0x5C: "iput-boolean",
    0x5D: "iput-byte", 0x5E: "iput-char", 0x5F: "iput-short",
    0x60: "sget", 0x61: "sget-wide", 0x62: "sget-object", 0x63: "sget-boolean",
    0x64: "sget-byte", 0x65: "sget-char", 0x66: "sget-short",
    0x67: "sput", 0x68: "sput-wide", 0x69: "sput-object", 0x6A: "sput-boolean",
    0x6B: "sput-byte", 0x6C: "sput-char", 0x6D: "sput-short",
    0x6E: "invoke-virtual", 0x6F: "invoke-super", 0x70: "invoke-direct",
    0x71: "invoke-static", 0x72: "invoke-interface",
    0x74: "invoke-virtual/range", 0x75: "invoke-super/range",
    0x76: "invoke-direct/range", 0x77: "invoke-static/range",
    0x78: "invoke-interface/range",
    0x7B: "neg-int", 0x7C: "not-int", 0x7D: "neg-long", 0x7E: "not-long",
    0x7F: "neg-float", 0x80: "neg-double", 0x81: "int-to-long",
    0x82: "int-to-float", 0x83: "int-to-double", 0x84: "long-to-int",
    0x85: "long-to-float", 0x86: "long-to-double", 0x87: "float-to-int",
    0x88: "float-to-long", 0x89: "float-to-double", 0x8A: "double-to-int",
    0x8B: "double-to-long", 0x8C: "double-to-float", 0x8D: "int-to-byte",
    0x8E: "int-to-char", 0x8F: "int-to-short",
    0xFA: "invoke-polymorphic", 0xFB: "invoke-polymorphic/range",
    0xFC: "invoke-custom", 0xFD: "invoke-custom/range",
    0xFE: "const-method-handle", 0xFF: "const-method-type",
}
for _o in range(0x90, 0xB0):
    NAME.setdefault(_o, "binop-0x%02x" % _o)
for _o in range(0xD0, 0xD8):
    NAME.setdefault(_o, "binop/lit16-0x%02x" % _o)
for _o in range(0xD8, 0xE3):
    NAME.setdefault(_o, "binop/lit8-0x%02x" % _o)
for _o in range(0xE3, 0xFA):
    NAME.setdefault(_o, "unused-0x%02x" % _o)


def regs_35c(word1):
    """35c 的 reg list: vC,vD,vE,vF,vG"""
    c = (word1 >> 12) & 0xF
    d = (word1 >> 8) & 0xF
    e = (word1 >> 4) & 0xF
    f = word1 & 0xF
    return c, d, e, f


def rlist(txt):
    return "{" + ",".join(txt) + "}"


def disasm(dex, ins, start=0, end=None, grep=None, show_raw=True):
    """返回 [(addr, text)]"""
    out = []
    n = len(ins)
    p = 0
    while p < n:
        if end is not None and p >= end:
            break
        op = ins[p]
        w = insn_size(ins, p)
        f = FMT.get(op)
        nm = NAME.get(op, "op-0x%02x" % op)
        if op == 0x00 and p + 1 < len(ins):
            ident = ins[p + 1]
            f = {0x01: "payload_packed", 0x02: "payload_sparse",
                 0x03: "payload_fill"}.get(ident, f)
            if f.startswith("payload"):
                nm = "payload"
        txt = None
        try:
            if f == "10x":
                txt = nm
            elif f == "11x":
                txt = f"{nm} v{ins[p+1]}"
            elif f == "11n":
                # 11n = B|A|op：A = 目标寄存器（低 nibble），B = 立即数（高 nibble）
                reg = ins[p + 1] & 0xF
                v = ins[p + 1] >> 4
                if v >= 8:
                    v -= 16
                txt = f"{nm} v{reg}, #{v}"
            elif f == "12x":
                txt = f"{nm} v{ins[p+1] & 0xF}, v{ins[p+1] >> 4}"
            elif f == "21c":
                idx = struct.unpack_from("<H", ins, p + 2)[0]
                if op == 0x1A:
                    r = dex.strings[idx] if idx < len(dex.strings) else "?"
                    txt = f'{nm} v{ins[p+1]}, "{r[:120]}"'
                elif op == 0x1C or op == 0x1F or op == 0x22:
                    r = dex.type_ids[idx] if idx < len(dex.type_ids) else "?"
                    txt = f"{nm} v{ins[p+1]}, {r}"
                else:
                    txt = f"{nm} v{ins[p+1]}, @{idx}"
            elif f == "31c":
                idx = struct.unpack_from("<I", ins, p + 2)[0]
                r = dex.strings[idx] if idx < len(dex.strings) else "?"
                txt = f'{nm} v{ins[p+1]}, "{r[:120]}"'
            elif f == "21s":
                v = struct.unpack_from("<h", ins, p + 2)[0]
                txt = f"{nm} v{ins[p+1]}, #+{v}"
            elif f == "21h":
                v = struct.unpack_from("<h", ins, p + 2)[0]
                txt = f"{nm} v{ins[p+1]}, #+{v}  (<<16 = {v << 16})"
            elif f == "31i":
                v = struct.unpack_from("<i", ins, p + 2)[0]
                txt = f"{nm} v{ins[p+1]}, #+{v}"
            elif f == "51l":
                v = struct.unpack_from("<q", ins, p + 2)[0]
                txt = f"{nm} v{ins[p+1]}, #+{v}"
            elif f == "22x":
                # 22x: op vAA, vBBBB  （move/from16 系列；AA=byte1 目标，BBBB=u16 源）
                src = struct.unpack_from("<H", ins, p + 2)[0]
                txt = f"{nm} v{ins[p + 1]}, v{src}"
            elif f == "22c":
                idx = struct.unpack_from("<H", ins, p + 2)[0]
                b = ins[p + 1]
                if op >= 0x52:
                    r = dex.field_ids[idx] if idx < len(dex.field_ids) else ("?", "?", "?")
                    txt = f"{nm} v{b & 0xF}, v{b >> 4}, {r[0]}.{r[2]}:{r[1]}"
                else:
                    r = dex.type_ids[idx] if idx < len(dex.type_ids) else "?"
                    txt = f"{nm} v{b & 0xF}, v{b >> 4}, {r}"
            elif f == "22s":
                v = struct.unpack_from("<h", ins, p + 2)[0]
                b = ins[p + 1]
                txt = f"{nm} v{b & 0xF}, v{b >> 4}, #+{v}"
            elif f == "22b":
                v = ins[p + 2]
                if v >= 128:
                    v -= 256
                b = ins[p + 1]
                txt = f"{nm} v{b & 0xF}, v{b >> 4}, #+{v}"
            elif f == "23x":
                txt = f"{nm} v{ins[p+1]}, v{ins[p+2]}, v{ins[p+3]}"
            elif f == "32x":
                a = struct.unpack_from("<H", ins, p + 2)[0]
                b = struct.unpack_from("<H", ins, p + 4)[0]
                txt = f"{nm} v{a}, v{b}"
            elif f == "31t":
                off = struct.unpack_from("<i", ins, p + 2)[0]
                txt = f"{nm} v{ins[p+1]}, +{off}  (→insn+{p // 2 + off})"
            elif f == "20t":
                off = struct.unpack_from("<h", ins, p + 2)[0]
                txt = f"{nm} +{off}  (→insn+{p // 2 + off})"
            elif f == "30t":
                off = struct.unpack_from("<i", ins, p + 2)[0]
                txt = f"{nm} +{off}  (→insn+{p // 2 + off})"
            elif f == "21t":
                off = struct.unpack_from("<h", ins, p + 2)[0]
                txt = f"{nm} v{ins[p+1]}, +{off}  (→insn+{p // 2 + off})"
            elif f == "payload_packed":
                size = struct.unpack_from("<H", ins, p + 2)[0]
                first = struct.unpack_from("<i", ins, p + 4)[0]
                tgts = struct.unpack_from("<%di" % size, ins, p + 8)
                pairs = ", ".join(f"{first + i}→insn+{t}" for i, t in enumerate(tgts))
                txt = f"packed-switch-payload size={size} first_key={first}  {pairs}"
            elif f == "payload_sparse":
                size = struct.unpack_from("<H", ins, p + 2)[0]
                keys = struct.unpack_from("<%di" % size, ins, p + 4)
                tgts = struct.unpack_from("<%di" % size, ins, p + 4 + 4 * size)
                pairs = ", ".join(f"{k}→insn+{t}" for k, t in zip(keys, tgts))
                txt = f"sparse-switch-payload size={size}  {pairs}"
            elif f == "payload_fill":
                ew = struct.unpack_from("<H", ins, p + 2)[0]
                size = struct.unpack_from("<I", ins, p + 4)[0]
                txt = f"fill-array-data-payload elem_width={ew} size={size}"
            elif f == "35c":
                idx = struct.unpack_from("<H", ins, p + 2)[0]
                w0 = struct.unpack_from("<H", ins, p)[0]
                g_count = (w0 >> 12) & 0xF       # A = 参数个数（1..5）
                fifth = (w0 >> 8) & 0xF          # G = 第 5 个寄存器
                byte4 = ins[p + 4]
                c = byte4 & 0xF
                d = byte4 >> 4
                e = ins[p + 5] & 0xF
                ff = ins[p + 5] >> 4
                if g_count == 5:
                    regs = [c, d, e, ff, fifth]
                else:
                    regs = [c, d, e, ff][:g_count]
                vs = ",".join("v%d" % x for x in regs)
                txt = f"{nm} {{{vs}}} (n={g_count}), {dex.msig(idx)}"
            elif f == "3rc":
                idx = struct.unpack_from("<H", ins, p + 2)[0]
                cnt = ins[p + 1]
                first = struct.unpack_from("<H", ins, p + 4)[0]
                txt = f"{nm} {{v{first}..v{first+cnt-1}}} (n={cnt}), {dex.msig(idx)}"
            elif f == "45cc":
                idx = struct.unpack_from("<H", ins, p + 2)[0]
                pidx = struct.unpack_from("<H", ins, p + 6)[0]
                r = dex.method_ids[idx] if idx < len(dex.method_ids) else ("?", "?")
                txt = f"{nm} {r[0]}.{r[1]} proto#{pidx}"
            elif f in ("4rcc",):
                idx = struct.unpack_from("<H", ins, p + 2)[0]
                r = dex.method_ids[idx] if idx < len(dex.method_ids) else ("?", "?")
                txt = f"{nm} {r[0]}.{r[1]}"
        except Exception as ex:
            txt = f"{nm} <decode-error {ex}>"
        if txt is None:
            txt = f"{nm} (raw {ins[p:p+w].hex()})"
        raw = ins[p:p + w].hex() if show_raw else ""
        line = f"  [{p:5d}] {raw:<24} {txt}"
        if grep is None or re.search(grep, txt):
            if p >= start:
                out.append(line)
        p += w
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--class", dest="cls", required=True)
    ap.add_argument("--method", dest="m", default=None, help="方法名正则")
    ap.add_argument("--dex", default=None)
    ap.add_argument("--grep", default=None, help="只打印匹配该正则的行")
    ap.add_argument("--max", type=int, default=100000)
    ap.add_argument("--no-raw", action="store_true")
    a = ap.parse_args()

    cls_rx = re.compile(a.cls)
    m_rx = re.compile(a.m) if a.m else None
    only = set(a.dex.split(",")) if a.dex else None
    dexes = load_dexes(a.path, only)

    for iname, dn, dex in dexes:
        for ci, cdesc in enumerate(dex.class_defs):
            if not cls_rx.search(cdesc):
                continue
            cd = dex.iter_class_data(ci)
            if not cd:
                continue
            direct, virtual = cd
            for (midx, acc, coff) in direct + virtual:
                mname = dex.method_ids[midx][1] if midx < len(dex.method_ids) else "?"
                if m_rx and not m_rx.search(mname):
                    continue
                if coff == 0:
                    print(f"\n### {dn} {cdesc} {mname}  (无代码)")
                    continue
                code = CodeItem(dex.d, coff, dex)
                # 归一化 <clinit> 便于用 --method clinit 匹配
                print(f"\n### {dn} {cdesc} {mname}  regs={code.registers_size} "
                      f"insns={len(code.insns)//2} units")
                lines = disasm(dex, code.insns, grep=a.grep, show_raw=not a.no_raw)
                for ln in lines[: a.max]:
                    print(ln)
                if len(lines) > a.max:
                    print(f"  ...（共 {len(lines)} 行，已截断）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
