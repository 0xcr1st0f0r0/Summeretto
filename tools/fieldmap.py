#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fieldmap.py —— 还原 protobuf-javalite 消息的「字段号 → 字段名 / 类型」表。

为什么需要它：
  阶段2 的终点是「手工构造 ProcessQueryRequest」。请求体是 proto2 扩展承载的
  javalite 消息（如 Lgcvm / Lgauy），字段号未知就没法拼 wire format。
  DEX 里没有 .proto，也没有 descriptor（lite 运行时不含 descriptor），
  字段号只存在于 dynamicMethod() 的 BUILD_MESSAGE_INFO 分支里：

      return newMessageInfo(DEFAULT_INSTANCE, "<info>", new Object[]{...});

原理（对照 protobuf 上游 RawMessageInfo / MessageSchema 源码）：

  1) <info> 是「13 bit / char」的变长整型编码（UTF-16 码元序列）：
       单值 <0xD800            → 该值本身
       首字符 >=0xD800         → 低 13 位有效，续接，直到遇到 <0xD800 的字符
                               value = c1 & 0x1FFF | (c2 & 0x1FFF)<<13 | ... | last<<shift
     注意：不使用 UTF-16 代理对区间，所以 0xD800..0xDFFF 只作「续接标记」用。

     info 顺序：
       [0] flags   (bit0=proto2, bit1=messageSetWireFormat, bit2=editions)
       [1] field count（0 → 空消息，objects 为 null）
       [2] oneof count
       [3] hasbits count（hasbits int 个数）
       [4] min field number
       [5] max field number
       [6] num entries（分配 buffer 用，= field count 一般）
       [7] map field count
       [8] repeated field count（新版不再使用，仅占位）
       [9] checkInitialized 数组大小
       之后，每个字段按序：
         fieldNumber, fieldTypeWithExtraBits, [oneofIndex | hasBitsIndex]
       附加位：0x100 required / 0x200 utf8 / 0x400 checkInit /
               0x800 legacy-closed-enum / 0x1000 hasHasBit（有 presence）
       类型 id(低 8 位)：
         0..17   单值 DOUBLE,FLOAT,INT64,UINT64,INT32,FIXED64,FIXED32,BOOL,
                 STRING,MESSAGE,BYTES,UINT32,ENUM,SFIXED32,SFIXED64,SINT32,SINT64,GROUP
         18..34  *_LIST
         35..48  *_LIST_PACKED
         49      GROUP_LIST
         50      MAP
         51+     ONEOF_TYPE_OFFSET(51) 偏移后的基类型 —— 字段是某个 oneof 的成员
       紧跟 fieldTypeWithExtraBits 的第三个值：
         - oneof 字段        → oneofIndex
         - 非 oneof 且 fieldType<=17 且有 HAS_HAS_BIT → hasBitsIndex
         - 其余              → 没有第三个值

  2) Object[] 三段式消费（objectsPosition 从 oneofCount*2 + hasBitsCount 起）：
       oneof 段：每个 oneof 2 项 [value 字段名, case 字段名]
       hasbits 段：每个 hasbits int 1 项
       字段段：每个 **非 oneof** 字段先消费 1 个「Java 字段名字符串」（反射用），
               再按类型决定是否额外消费：
                 MESSAGE(9)/GROUP(17)          → 不额外消费（反射取 field.getType()）
                 MESSAGE_LIST(27)/GROUP_LIST(49) → +1（message class）
                 ENUM(12)/ENUM_LIST(30)/ENUM_LIST_PACKED(44)
                                               → proto2 或 legacy-closed 时 +1（EnumLiteMap）
                 MAP(50)                        → +1（map default entry），closed enum 再 +1
       oneof 字段本身不消费字段名字符串（名字在 oneof 段里）。

输出：字段号 | 类型 | 附加标志 | Java 字段名 | 声明类型 | 关联类/enum

用法:
  python tools/fieldmap.py apk/AGSA_17.66.12.xapk --class "^Lgcvd;$"
  python tools/fieldmap.py apk/... --class "^Lg" --out out/robin/fieldmap.txt
  python tools/fieldmap.py apk/... --class "^Lgauy;$" --raw
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

# ── FieldType 表（对照 com.google.protobuf.FieldType 顺序） ──────────
_SINGLE = ["DOUBLE", "FLOAT", "INT64", "UINT64", "INT32", "FIXED64", "FIXED32", "BOOL",
           "STRING", "MESSAGE", "BYTES", "UINT32", "ENUM", "SFIXED32", "SFIXED64",
           "SINT32", "SINT64", "GROUP"]
_LIST = ["DOUBLE_LIST", "FLOAT_LIST", "INT64_LIST", "UINT64_LIST", "INT32_LIST",
         "FIXED64_LIST", "FIXED32_LIST", "BOOL_LIST", "STRING_LIST", "MESSAGE_LIST",
         "BYTES_LIST", "UINT32_LIST", "ENUM_LIST", "SFIXED32_LIST", "SFIXED64_LIST",
         "SINT32_LIST", "SINT64_LIST"]
_PACKED = ["DOUBLE_LIST_PACKED", "FLOAT_LIST_PACKED", "INT64_LIST_PACKED",
           "UINT64_LIST_PACKED", "INT32_LIST_PACKED", "FIXED64_LIST_PACKED",
           "FIXED32_LIST_PACKED", "BOOL_LIST_PACKED", "UINT32_LIST_PACKED",
           "ENUM_LIST_PACKED", "SFIXED32_LIST_PACKED", "SFIXED64_LIST_PACKED",
           "SINT32_LIST_PACKED", "SINT64_LIST_PACKED"]
ONEOF_OFFSET = 51

TYPES = {}
for i, n in enumerate(_SINGLE):
    TYPES[i] = n
for i, n in enumerate(_LIST):
    TYPES[18 + i] = n
for i, n in enumerate(_PACKED):
    TYPES[35 + i] = n
TYPES[49] = "GROUP_LIST"
TYPES[50] = "MAP"

BIT_REQUIRED = 0x100
BIT_UTF8 = 0x200
BIT_CHECKINIT = 0x400
BIT_CLOSED_ENUM = 0x800
BIT_HASBIT = 0x1000


def type_name(t):
    if t >= ONEOF_OFFSET:
        base = TYPES.get(t - ONEOF_OFFSET, "?")
        return f"ONEOF<{base}>"
    return TYPES.get(t, f"?{t}")


# ── info 字符串解码 ────────────────────────────────────────────────
def decode_ints(s):
    """把 13-bit/char 变长编码的 info 字符串码元解成 int 序列。

    ⚠️ 入参必须是 **UTF-16 码元列表**（dex.units_at(idx)），不能是显示用字符串：
    D800..DFFF 是续接标记，显示层会把它替换成 U+FFFD，直接毁掉数据。
    兼容入参为 str（此时 ord() 取码元）。
    """
    vals = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i] if isinstance(s[i], int) else ord(s[i])
        i += 1
        if c < 0xD800:
            vals.append(c)
            continue
        result = c & 0x1FFF
        shift = 13
        while True:
            if i >= n:
                vals.append(result)       # 截断（不应发生）
                return vals
            c = s[i] if isinstance(s[i], int) else ord(s[i])
            i += 1
            if c >= 0xD800:
                result |= (c & 0x1FFF) << shift
                shift += 13
            else:
                break
        vals.append(result | (c << shift))
    return vals


# ── 指令级提取：从 dynamicMethod 里拿到 (info 字符串, Object[] 字面量) ──
def _u16(b, p):
    return struct.unpack_from("<H", b, p)[0]


def _u32(b, p):
    return struct.unpack_from("<I", b, p)[0]


def _i16(b, p):
    return struct.unpack_from("<h", b, p)[0]


def _i32(b, p):
    return struct.unpack_from("<i", b, p)[0]


def _regs_35c(ins, p):
    w0 = _u16(ins, p)
    cnt = (w0 >> 12) & 0xF
    fifth = (w0 >> 8) & 0xF
    c = ins[p + 4] & 0xF
    d = ins[p + 4] >> 4
    e = ins[p + 5] & 0xF
    f = ins[p + 5] >> 4
    return ([c, d, e, f, fifth][:cnt] if cnt <= 4 else [c, d, e, f, fifth])


# ── 分支/块结束指令（后向遍历时遇到即视为到达基本块首） ──────────────
BRANCH_OPS = frozenset(
    [0x0E, 0x0F, 0x10, 0x11,           # return / return-void
     0x27,                              # throw
     0x28, 0x29, 0x2A,                  # goto /16 /32
     0x2B, 0x2C,                        # packed-switch / sparse-switch
     0x2D, 0x2E, 0x2F, 0x30, 0x31]      # cmp*（后接分支，视作块尾更安全）
    + list(range(0x32, 0x3E))           # if-* 22t / if-*z 21t
)


def _write(vals, op, ins, p, dex):
    """若该指令写寄存器，则记录到 vals 并返回 True。

    ⚠️ DEX 记法 `B|A|op`：A 恒为**低**半字节（与 `const/4 vA, #+B` 一致），
    `new-array vA, vB` 的目标寄存器因此是 `byte & 0xF`。
    """
    if op == 0x1A:                                    # const-string
        vals[ins[p + 1]] = ("str", _u16(ins, p + 2))
        return True
    if op == 0x1B:                                    # const-string/jumbo
        vals[ins[p + 1]] = ("str", _u32(ins, p + 2))
        return True
    if op == 0x1C:                                    # const-class
        idx = _u16(ins, p + 2)
        vals[ins[p + 1]] = ("class",
                            dex.type_ids[idx] if idx < len(dex.type_ids) else "?")
        return True
    if op == 0x62:                                    # sget-object
        idx = _u16(ins, p + 2)
        c, t, nm = dex.field_ids[idx] if idx < len(dex.field_ids) else ("?", "?", "?")
        vals[ins[p + 1]] = ("sget", f"{c}->{nm}:{t}")
        return True
    if op == 0x12:                                    # const/4
        v = ins[p + 1] >> 4
        if v >= 8:
            v -= 16
        vals[ins[p + 1] & 0xF] = ("int", v)
        return True
    if op == 0x13:                                    # const/16
        vals[ins[p + 1]] = ("int", _i16(ins, p + 2))
        return True
    if op == 0x14:                                    # const
        vals[ins[p + 1]] = ("int", _i32(ins, p + 2))
        return True
    if op == 0x15:                                    # const/high16
        vals[ins[p + 1]] = ("int", _i16(ins, p + 2) << 16)
        return True
    if op == 0x23:                                    # new-array vA, vB, type (22c)
        vals[ins[p + 1] & 0xF] = ("arr_new", p)       # A=低半字节（B|A|op 记法）
        return True
    if op == 0x24:                                    # filled-new-array {..} (35c)
        return True
    if op == 0x07:                                    # move-object (12x)
        src = ins[p + 1] >> 4
        dst = ins[p + 1] & 0xF
        if src != dst:
            vals[dst] = ("alias", src)
        return True
    if op == 0x08:                                    # move-object/from16 (22x)
        src = _u16(ins, p + 2)
        vals[ins[p + 1]] = ("alias", src)
        return True
    return False


def extract_message_info(dex, ins):
    """定位 invoke …newMessageInfo(MessageLite,String,Object[]) 并解析其实参。

    返回 (info 码元列表, [obj...], diag)。

    ⚠️ 字符串在寄存器里以「字符串池下标」流转，最后才 *resolve* —— 因为
    info 字符串必须走 dex.units_at()（保留代理码元），不能用显示用字符串。

    数据流策略（**后向求值 + 序言回退**）：
      · dynamicMethod 是编译器生成的 switch 分发体，newMessageInfo 段只是
        其中一个基本块；线性前向跟踪会被**死分支**里的寄存写污染
        （实测 Lgbku：死分支 `sget-object v5` 覆盖了序言的 `const/4 v5,#6`）。
      · 因此改为：从每条指令出发**后向**扫到基本块首，取「最近一次写」；
        块内没有定义则回退到「序言值」（首个分支指令之前的前向状态）。
      · 序言保存了寄存器分组常量（数组下标 0..N 被预置成不同寄存器）。
    """
    n = len(ins)
    starts = []
    p = 0
    while p < n:
        starts.append(p)
        p += insn_size(ins, p)
    if not starts:
        return None, None, ["空指令流"]

    # ── ① 定位调用点 ─────────────────────────────────────────────
    call_i = call_rr = None
    for i, p in enumerate(starts):
        op = ins[p]
        if op not in (0x71, 0x77):
            continue
        idx = _u16(ins, p + 2)
        if idx >= len(dex.method_ids):
            continue
        if dex.method_ids[idx][1] != "newMessageInfo":
            continue
        if op == 0x71:
            rr = _regs_35c(ins, p)
        else:
            first = _u16(ins, p + 4)
            rr = list(range(first, first + ins[p + 1]))
        if len(rr) >= 3:
            call_i, call_rr = i, rr
            break
    if call_i is None:
        return None, None, ["指令流中未找到 newMessageInfo 调用"]

    # ── ② 序言值（首个分支/返回之前的前向状态） ─────────────────
    prologue = {}
    for p in starts:
        if ins[p] in BRANCH_OPS:
            break
        _write(prologue, ins[p], ins, p, dex)
    # 序言内的别名就地解开
    for r in list(prologue):
        seen = 0
        v = prologue[r]
        while v and v[0] == "alias" and seen < 8:
            v = prologue.get(v[1])
            seen += 1
        prologue[r] = v

    def val_at(idx, r, depth=0):
        """求「指令索引 idx（含）之前」寄存器 r 的值。"""
        if depth > 8:
            return None
        i = idx
        while i >= 0:
            p = starts[i]
            op = ins[p]
            if op in BRANCH_OPS:
                break
            tmp = {}
            if _write(tmp, op, ins, p, dex) and r in tmp:
                v = tmp[r]
                if v and v[0] == "alias":
                    return val_at(i - 1, v[1], depth + 1)
                return v
            i -= 1
        v = prologue.get(r)
        if v and v[0] == "alias":
            return val_at(-1, v[1], depth + 1)
        return v

    def block_scan(idx):
        """从 idx 后向扫到块首，产出块内指令索引列表。"""
        out = []
        i = idx
        while i >= 0:
            if i != idx and ins[starts[i]] in BRANCH_OPS:
                break
            out.append(i)
            i -= 1
        return out

    blk = block_scan(call_i)

    # ── ③ info 字符串 ───────────────────────────────────────────
    info_units = None
    iv = val_at(call_i - 1, call_rr[1])
    if iv and iv[0] == "str":
        info_units = dex.units_at(iv[1])

    # ── ④ objects 数组 ──────────────────────────────────────────
    arr_reg = None            # new-array 目标寄存器
    fill_i = fill_rr = None   # filled-new-array
    for i in blk:
        p = starts[i]
        op = ins[p]
        if op == 0x23:
            arr_reg = ins[p + 1] & 0xF
            break
    for i in blk:
        p = starts[i]
        if ins[p] == 0x24:
            fill_rr = _regs_35c(ins, p)
            fill_i = i
            # filled-new-array 的结果常经 move-result-object 落到某个寄存器
            for j in range(i + 1, call_i + 1):
                if ins[starts[j]] == 0x0C:
                    arr_reg = ins[starts[j] + 1]
                    break
            break

    d = {}
    if fill_i is not None:
        for k, r in enumerate(fill_rr):
            d[k] = val_at(fill_i - 1, r)
    # aput-object 覆盖/补齐
    if arr_reg is not None:
        for i in reversed(blk):
            p = starts[i]
            if ins[p] != 0x4D:                       # aput-object vAA, vBB, vCC
                continue
            if ins[p + 2] != arr_reg:
                continue
            kv = val_at(i - 1, ins[p + 3])
            if not kv or kv[0] != "int":
                continue
            d[kv[1]] = val_at(i - 1, ins[p + 1])

    objs = None
    if d:
        objs = [d.get(i) for i in range(max(d.keys()) + 1)]
        objs = [("?", None) if v is None else
                (v[0], dex.strings[v[1]]
                 if v[0] == "str" and isinstance(v[1], int) and v[1] < len(dex.strings)
                 else (None if v[0] in ("arr_new", "arr_fill") else v[1]))
                for v in objs]
    elif fill_i is not None or arr_reg is not None:
        objs = []

    diag = []
    if info_units is None:
        diag.append(f"@{starts[call_i]} info 字符串未解析到（v{call_rr[1]}）")
    if objs is None:
        diag.append(f"@{starts[call_i]} objects 数组未解析到（v{call_rr[2]}）")
    return info_units, objs, diag


# ── 主解码：info + objects → 字段表 ────────────────────────────────
def decode_field_table(info, objs, declared=None):
    """返回 (header dict, [field dict...], objects 消费游标, 诊断)"""
    vals = decode_ints(info)
    diag = []
    i = 0

    def nxt():
        nonlocal i
        if i >= len(vals):
            raise IndexError("info 数值用尽")
        v = vals[i]
        i += 1
        return v

    flags = nxt()
    proto2 = bool(flags & 0x1)
    field_count = nxt()
    header = {"flags": flags, "proto2": proto2, "message_set": bool(flags & 0x2),
              "editions": bool(flags & 0x4), "field_count": field_count,
              "consumed": 0, "total_ints": len(vals)}
    if field_count == 0:
        header.update(oneof_count=0, hasbits_count=0, min_field=0, max_field=0,
                      num_entries=0, map_count=0, checkinit=0,
                      consumed=i, objects_pos=0, objects_len=len(objs) if objs else 0)
        return header, [], 0, diag

    oneof_count = nxt()
    hasbits_count = nxt()
    header.update(oneof_count=oneof_count, hasbits_count=hasbits_count,
                  min_field=nxt(), max_field=nxt())
    header["num_entries"] = nxt()
    header["map_count"] = nxt()
    header["repeated_unused"] = nxt()
    header["checkinit"] = nxt()

    pos = oneof_count * 2 + hasbits_count      # objects 游标起点

    def take_obj():
        nonlocal pos
        if objs is None or pos >= len(objs):
            diag.append(f"objects 游标越界 pos={pos} len={len(objs) if objs else 0}")
            return None
        v = objs[pos]
        pos += 1
        return v

    fields = []
    for _ in range(field_count):
        fnum = nxt()
        ftbits = nxt()
        ftype = ftbits & 0xFF
        entry = {"num": fnum, "bits": ftbits, "type": ftype,
                 "type_name": type_name(ftype),
                 "required": bool(ftbits & BIT_REQUIRED),
                 "utf8": bool(ftbits & BIT_UTF8),
                 "check_init": bool(ftbits & BIT_CHECKINIT),
                 "closed_enum": bool(ftbits & BIT_CLOSED_ENUM),
                 "hasbit": bool(ftbits & BIT_HASBIT),
                 "name": None, "decl": None, "ref": None,
                 "oneof_index": None, "hasbit_index": None}
        if ftype >= ONEOF_OFFSET:
            oi = nxt()
            entry["oneof_index"] = oi
            base = ftype - ONEOF_OFFSET
            if base in (9, 17):
                r = take_obj()
                entry["ref"] = r[1] if r else None
            elif base == 12 and (proto2 or entry["closed_enum"]):
                r = take_obj()
                entry["ref"] = r[1] if r else None
            # 名字在 oneof 段：objects[oneofIndex*2] = value 字段名, +1 = case 字段名
            if objs is not None and oi * 2 + 1 < len(objs):
                vv = objs[oi * 2]
                cc = objs[oi * 2 + 1]
                entry["name"] = vv[1] if vv else None
                entry["oneof_case_field"] = cc[1] if cc else None
        else:
            r = take_obj()
            entry["name"] = r[1] if r else None
            if ftype in (27, 49):
                r2 = take_obj()
                entry["ref"] = r2[1] if r2 else None
            elif ftype in (12, 30, 44) and (proto2 or entry["closed_enum"]):
                r2 = take_obj()
                entry["ref"] = r2[1] if r2 else None
            elif ftype == 50:
                r2 = take_obj()
                entry["ref"] = r2[1] if r2 else None
                if entry["closed_enum"]:
                    take_obj()
            if entry["hasbit"] and ftype <= 17:
                entry["hasbit_index"] = nxt()
        if declared and entry["name"] in declared:
            dt, acc = declared[entry["name"]]
            entry["decl"] = dt
            entry["decl_acc"] = acc
        # 非 oneof 的 MESSAGE/GROUP 字段：javalite 不消费 objects（靠反射 field.getType()），
        # 所以 ref 为空 —— 用「声明字段类型」补上，否则对象图会断链
        if entry["ref"] is None and entry["decl"]:
            base = ftype - (ONEOF_OFFSET if ftype >= ONEOF_OFFSET else 0)
            if base in (9, 17) and entry["decl"].startswith("L"):
                entry["ref"] = entry["decl"]
        fields.append(entry)
    header["consumed"] = i
    header["objects_pos"] = pos
    header["objects_len"] = len(objs) if objs else 0
    return header, fields, pos, diag


# ── 载入 ──────────────────────────────────────────────────────────
def load_dexes(path, only=None):
    out = []
    z = zipfile.ZipFile(path)
    entries = z.namelist()
    inner = [n for n in entries if n.lower().endswith(".apk")]
    if inner:
        for iname in inner:
            zz = zipfile.ZipFile(io.BytesIO(z.read(iname)))
            for dn in sorted(n for n in zz.namelist() if re.match(r"^classes\d*\.dex$", n)):
                if only and dn not in only:
                    continue
                out.append((iname, dn, DexFile(zz.read(dn), dn)))
            zz.close()
    else:
        for dn in sorted(n for n in entries if re.match(r"^classes\d*\.dex$", n)):
            if only and dn not in only:
                continue
            out.append((os.path.basename(path), dn, DexFile(z.read(dn), dn)))
    z.close()
    return out


def fmt_flags(e):
    f = []
    if e["required"]:
        f.append("REQ")
    if e["utf8"]:
        f.append("UTF8")
    if e["check_init"]:
        f.append("CHKINIT")
    if e["closed_enum"]:
        f.append("CLOSED")
    if e["hasbit"]:
        f.append("HASBIT")
    return ",".join(f) or "-"


def short(t):
    """描述符缩短显示"""
    if t is None:
        return "-"
    t = str(t)
    if t.startswith("L") and t.endswith(";"):
        return t[1:-1]
    return t


def process(dex, ci, cdesc, declared, out_lines, show_raw, brief):
    cd = dex.iter_class_data(ci)
    if not cd:
        return False
    direct, virtual = cd
    for (midx, acc, coff) in list(direct) + list(virtual):
        mname = dex.method_ids[midx][1] if midx < len(dex.method_ids) else "?"
        if mname != "dynamicMethod" or coff == 0:
            continue
        code = CodeItem(dex.d, coff, dex)
        info, objs, diag = extract_message_info(dex, code.insns)
        if info is None:
            for d in diag:
                out_lines.append(f"    ! {cdesc} {d}")
            return False
        header, fields, pos, d2 = decode_field_table(info, objs, declared)
        diag += d2
        # 头部
        if not brief:
            out_lines.append(
                f"## {cdesc}  字段数={header['field_count']} "
                f"proto={'2' if header['proto2'] else '3'}"
                f"{'/editions' if header['editions'] else ''}"
                f"{'  messageSet' if header['message_set'] else ''}  "
                f"oneof={header['oneof_count']} hasbits={header['hasbits_count']} "
                f"field范围={header['min_field']}..{header['max_field']} "
                f"map={header['map_count']} checkInit={header['checkinit']}")
        for e in fields:
            one = f" oneof#{e['oneof_index']}" if e["oneof_index"] is not None else ""
            hb = f" hasbit#{e['hasbit_index']}" if e["hasbit_index"] is not None else ""
            nm = e["name"] or "?"
            decl = short(e["decl"]) or "?"
            ref = f"  →{short(e['ref'])}" if e["ref"] else ""
            if brief:
                out_lines.append(f"  {e['num']:>5} {e['type_name']:<22} {nm:<22} {decl}{ref}{one}{hb}")
            else:
                out_lines.append(
                    f"  #{e['num']:<6} {e['type_name']:<22} [{fmt_flags(e)}] "
                    f"{nm:<24} {decl}{ref}{one}{hb}")
        if show_raw:
            out_lines.append(f"    raw info({len(info)} units): " +
                             " ".join(f"{u:04X}" for u in info))
            out_lines.append(f"    objs({len(objs) if objs else 0}): " +
                             ", ".join(f"{v[0]}:{short(v[1])}" for v in (objs or [])))
        for d in diag:
            out_lines.append(f"    ! {d}")
        if not brief:
            out_lines.append(f"    (info 用尽 {header['consumed']}/{header['total_ints']} ints; "
                             f"objects 用尽 {pos}/{header['objects_len']})")
        out_lines.append("")
        return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--class", dest="cls", required=True, help="类描述符正则")
    ap.add_argument("--dex", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--raw", action="store_true", help="打印 info 字符串原始码元")
    ap.add_argument("--brief", action="store_true", help="紧凑输出")
    ap.add_argument("--max", type=int, default=100000)
    a = ap.parse_args()

    cls_rx = re.compile(a.cls)
    only = set(a.dex.split(",")) if a.dex else None
    dexes = load_dexes(a.path, only)

    lines = []
    hit = 0
    for iname, dn, dex in dexes:
        for ci, cdesc in enumerate(dex.class_defs):
            if not cls_rx.search(cdesc):
                continue
            sfields, ifields = dex.class_fields(ci)
            declared = {n: (t, acc) for (_c, t, n, acc) in ifields}
            if process(dex, ci, cdesc, declared, lines, a.raw, a.brief):
                if not a.brief:
                    lines.insert(len(lines) - 1, f"-- [{dn}]")
                hit += 1
                if hit >= a.max:
                    break
        if hit >= a.max:
            break

    text = ("\n".join(lines)).strip()
    if a.out:
        os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        print(f"[+] {hit} 个消息类 → {a.out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
