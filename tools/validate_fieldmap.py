#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""校验 fieldmap 的 objects 游标起点模型。

两个候选模型：
  A) pos = oneof_count*2 + hasbits_count      （当前实现）
  B) pos = oneof_count*2                      （无 hasbits 偏移）

评分标准：解码出的字段名必须能在类的「声明字段表」里找到，且
proto 类型与 Java 声明类型**一致**（STRING↔Ljava/lang/String;、
BOOL↔Z、INT32/ENUM↔I、MESSAGE↔L<类>;、BYTES↔Lgodd; 等）。
命中率高者胜。
"""
import io
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dexlib import DexFile                      # noqa: E402
from fieldmap import (extract_message_info, decode_field_table,  # noqa: E402
                      load_dexes)

# proto 类型 → 允许的 Java 声明类型（前缀匹配）
TYPE_OK = {
    1: ("D",),          # DOUBLE
    2: ("F",),          # FLOAT
    3: ("J",),          # INT64
    4: ("J",),          # UINT64
    5: ("I",),          # INT32
    6: ("J",),          # FIXED64
    7: ("I",),          # FIXED32
    8: ("Z",),          # BOOL
    9: ("L",),          # MESSAGE（且必须是 proto 消息类）
    10: ("L",),         # GROUP
    11: ("L",),         # STRING
    12: ("I",),         # ENUM
    13: ("I",),         # UINT32
    14: ("L",),         # SFIXED32
    15: ("J",),         # SFIXED64
    16: ("I",),         # SINT32
    17: ("J",),         # SINT64
    18: ("D",), 19: ("F",), 20: ("J",), 21: ("J",), 22: ("I",), 23: ("J",),
    24: ("I",), 25: ("Z",), 28: ("L",), 31: ("I",), 33: ("I",), 34: ("J",),
}
LIST_BASE = {  # LIST/PACKED_LIST id → 元素类型 id
    18: 1, 19: 2, 20: 3, 21: 4, 22: 5, 23: 6, 24: 7, 25: 8,
    27: 9, 28: 11, 29: 12, 30: 12, 31: 13, 32: 14, 33: 15,
    34: 16, 35: 17, 36: 1, 37: 2, 38: 3, 39: 4, 40: 5, 41: 6,
    42: 7, 43: 8, 44: 12, 45: 13, 46: 14, 47: 15, 48: 16, 49: 17,
}
ONEOF_OFFSET = 51


def expected_types(ftype):
    """返回该 proto 字段类型「允许的 Java 声明类型」前缀元组。"""
    if ftype >= ONEOF_OFFSET:
        return expected_types(ftype - ONEOF_OFFSET)
    if ftype in (27, 28, 30, 49):
        return ("Ljava/util/List;", "Ljava/util/List<", "Lcom/google/protobuf/", "Lg")
    if ftype in LIST_BASE:
        base = LIST_BASE[ftype]
        if base in (1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 15, 16, 17):
            return ("Ljava/util/List;", "I", "Lcom/google/protobuf/", "Lg")
        return ("Ljava/util/List;", "Lcom/google/protobuf/", "Lg")
    if ftype == 50:
        return ("Ljava/util/Map;", "Lcom/google/protobuf/")
    return TYPE_OK.get(ftype, ())


def _tally(fields, declared):
    """判据：字段名必须命中该类的「声明字段表」。

    偏移哪怕错 1 位，从字符串池里捞出来的名字基本不可能命中——
    字符串池有 60 万条候选，而单类声名字段仅 1~30 个，故该判据极灵敏。
    """
    n_ok = n_tot = 0
    for e in fields:
        n_tot += 1
        nm = e["name"]
        if nm and declared and nm in declared:
            n_ok += 1
    return n_ok, n_tot


def score(dex, ci, cdesc, model):
    """返回 (匹配数, 总数) —— model='A'|'B'。

    模型 B 等价于把 objects 砍掉前 hasbits_count 项后按 oneof*2 起算：
      objs_B[p + k] == objs[hasbits + oneof*2 + k]  → 正好等于 A 的索引。
    """
    cd = dex.iter_class_data(ci)
    if not cd:
        return None
    direct, virtual = cd
    for (midx, acc, coff) in list(direct) + list(virtual):
        mname = dex.method_ids[midx][1] if midx < len(dex.method_ids) else "?"
        if mname != "dynamicMethod" or coff == 0:
            continue
        from codeitem import CodeItem
        code = CodeItem(dex.d, coff, dex)
        info, objs, _diag = extract_message_info(dex, code.insns)
        if info is None:
            return None
        sfields, ifields = dex.class_fields(ci)
        declared = {n: (t, acc) for (_c, t, n, acc) in ifields}
        try:
            header, fields, pos, _ = decode_field_table(info, objs, declared)
        except IndexError:
            return None
        if header["field_count"] == 0:
            return None
        if model == "A":
            return _tally(fields, declared)
        hb = header["hasbits_count"]
        if not objs or hb <= 0:
            return _tally(fields, declared)
        try:
            _h2, fields_b, _p2, _d2 = decode_field_table(
                info, objs[hb:], declared)
        except IndexError:
            return (0, len(fields))
        return _tally(fields_b, declared)
    return None


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "apk/AGSA_17.66.12.xapk"
    dexes = load_dexes(path, None)
    totA = totB = nA = nB = cls_n = 0
    bad_A, bad_B = [], []
    for iname, dn, dex in dexes:
        for ci, cdesc in enumerate(dex.class_defs):
            ra = score(dex, ci, cdesc, "A")
            if not ra:
                continue
            rb = score(dex, ci, cdesc, "B")
            cls_n += 1
            a_ok, a_tot = ra
            b_ok, b_tot = rb if rb else (0, a_tot)
            nA += a_ok
            nB += b_ok
            totA += a_tot
            totB += a_tot
            if a_ok < a_tot:
                bad_A.append((cdesc, a_ok, a_tot, dn))
            if b_ok < b_tot:
                bad_B.append((cdesc, b_ok, b_tot, dn))
    print(f"消息类总数: {cls_n}")
    print(f"模型 A (oneof*2 + hasbits)  类型一致: {nA}/{totA}  "
          f"({100.0 * nA / max(totA, 1):.2f}%)   不一致类: {len(bad_A)}")
    print(f"模型 B (oneof*2)            类型一致: {nB}/{totB}  "
          f"({100.0 * nB / max(totB, 1):.2f}%)   不一致类: {len(bad_B)}")
    print("\n--- 模型 A 不一致样例（前 40） ---")
    for c, ok, t, dn in bad_A[:40]:
        print(f"  {c:<28} {ok}/{t}  [{dn}]")
    print("\n--- 模型 B 不一致样例（前 20） ---")
    for c, ok, t, dn in bad_B[:20]:
        print(f"  {c:<28} {ok}/{t}  [{dn}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
