#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
protoschema.py —— 从 javalite 消息类提取「声明字段 + RawMessageInfo 字段表」。

背景：R8 会把 protobuf 消息的访问器大量删除，dumpclass 只看得见「被访问」的字段。
真正的字段声明在 class_data_item 里；字段编号/类型则编码在
dynamicMethod → newMessageInfo(MessageLite, String, Object[]) 的那个二进制 String 里。

用法:
  python tools/protoschema.py apk/AGSA_17.66.12.xapk --class "^Lgcvp;$"
  python tools/protoschema.py apk/... --class "^Lgcv[pq];$" --blob
"""
import argparse
import io
import os
import re
import struct
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dexlib import DexFile, uleb128  # noqa
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


def raw_string(dex, idx, maxlen=4096):
    """取字符串的「原始字节」（不做 UTF-8 修复，RawMessageInfo 可能是二进制）。"""
    d = dex.d
    # 重新定位 string_ids
    (size,) = struct.unpack_from("<I", d, 56)
    (off,) = struct.unpack_from("<I", d, 60)
    if idx >= size:
        return b""
    (data_off,) = struct.unpack_from("<I", d, off + idx * 4)
    _, p = uleb128(d, data_off)
    end = d.find(b"\x00", p)
    return d[p:min(end, p + maxlen)]


def find_method_code(dex, ci, name_rx):
    cd = dex.iter_class_data(ci)
    if not cd:
        return []
    res = []
    for (midx, acc, coff) in cd[0] + cd[1]:
        if coff and name_rx.search(dex.method_ids[midx][1]):
            res.append((midx, coff))
    return res


def const_strings_in(dex, coff):
    """返回 [(byte_offset, str_idx, raw_len)]"""
    ins = CodeItem(dex.d, coff, dex).insns
    out = []
    p = 0
    while p + 4 <= len(ins):
        op = ins[p]
        if op == OP_CONST_STRING:
            idx = struct.unpack_from("<H", ins, p + 2)[0]
            out.append((p, idx))
            p += 4
        elif op == OP_CONST_STRING_JUMBO:
            idx = struct.unpack_from("<I", ins, p + 2)[0]
            out.append((p, idx))
            p += 6
        else:
            p += insn_size(ins, p)
    return out


def dump_blob(raw, label=""):
    printable = "".join(chr(b) if 32 <= b < 127 else "." for b in raw)
    print(f"    [{label}] len={len(raw)} raw_bytes={raw[:64].hex()}")
    print(f"    [{label}] ascii: {printable[:200]}")
    # 作为 char 序列（MUTF-8 解码为 16 位）
    try:
        chars = raw.decode("utf-8", errors="replace")
    except Exception:
        chars = ""
    codes = [ord(c) for c in chars]
    print(f"    [{label}] chars={len(codes)}")
    for i in range(0, min(len(codes), 64), 8):
        seg = codes[i:i + 8]
        print("      " + " ".join(f"{c:5d}(0x{c:04x})" for c in seg))
    # 解释：低位 3 bit = FieldType，高位 = 字段号
    print(f"    [{label}] 猜测解析 (fieldNum = c>>3, type = c&7):")
    for i, c in enumerate(codes[:80]):
        print(f"      #{i:3d} 0x{c:04x} = {c:5d}  → fieldNum={c >> 3:4d} type={c & 7}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--class", dest="cls", required=True)
    ap.add_argument("--method", dest="m", default="dynamicMethod")
    ap.add_argument("--blob", action="store_true", help="打印二进制 blob 明细")
    a = ap.parse_args()
    rx = re.compile(a.cls)
    mrx = re.compile(a.m)

    for dn, dex in load_all(a.path):
        for ci, cdesc in enumerate(dex.class_defs):
            if not rx.search(cdesc):
                continue
            print(f"\n########## [{dn}] {cdesc}  super={dex.class_supers[ci]} "
                  f"ifaces={list(dex.class_ifaces[ci])}")
            sf, inf = dex.class_fields(ci)
            print(f"  ▸ 静态字段 {len(sf)}:")
            for (c, t, n, acc) in sf:
                print(f"      {n} : {t}   (acc=0x{acc:x})")
            print(f"  ▸ 实例字段 {len(inf)}:")
            for (c, t, n, acc) in inf:
                print(f"      {n} : {t}   (acc=0x{acc:x})")
            for (midx, coff) in find_method_code(dex, ci, mrx):
                print(f"  ▸ 方法 {dex.msig(midx)}")
                for (p, sidx) in const_strings_in(dex, coff):
                    raw = raw_string(dex, sidx)
                    if len(raw) > 8 or not a.blob:
                        print(f"      @insn+{p // 2} str#{sidx} len={len(raw)} "
                              f"ascii={raw[:120]!r}")
                    if a.blob:
                        dump_blob(raw, f"str#{sidx}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
