#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
codeitem.py —— DEX 字节码解析（阶段2 必需）

为什么需要它：
  DexFile 只给出「全局字符串池」，丢失了归属关系 —— 我知道有 "converse mode" 这个字符串，
  但不知道它在哪个类、哪个方法里被引用。
  阶段2 要反推 payload 构造，必须知道「哪个类用哪个字符串、按什么顺序」。

提供：
  1. CodeItem 解析（指令流 + try/catch + debug_info）
  2. 指令解码（const-string / invoke-* / sget / iget / new-instance 等关键 opcode）
  3. String归属索引：method -> [strings]
  4. @Protobuf 注解恢复：字段编号（tag=值）

只实现「够用」的子集：覆盖 const-string 系列、invoke 系列、new-instance、
字段访问、以及 invoke 的参数个数（用于还原调用序列）。
"""
import struct

# ── opcodes（只列需要解码的） ──────────────────────────────────────
OP_CONST_STRING = 0x1A          # 21c
OP_CONST_STRING_JUMBO = 0x1B
OP_CONST_STRING_ENUM = 0x1B
OP_CONST_METHOD_HANDLE = 0x1D
OP_CONST_METHOD_TYPE = 0x1F
OP_CONST_CLASS = 0x1C

OP_SGET = 0x60# 21c
OP_SGET_WIDE = 0x61
OP_SGET_OBJECT = 0x62
OP_SGET_BOOLEAN = 0x63
OP_SGET_BYTE = 0x64
OP_SGET_CHAR = 0x65
OP_SGET_SHORT = 0x66
OP_SGET_WIDE2 = 0x67
OP_SPUT = 0x67 + 1              # 0x68

OP_IGET = 0x52
OP_IGET_WIDE = 0x53
OP_IGET_OBJECT = 0x54
OP_IGET_BOOLEAN = 0x55
OP_IGET_BYTE = 0x56
OP_IGET_CHAR = 0x57
OP_IGET_SHORT = 0x58

OP_INVOKE_VIRTUAL = 0x6E        # 35c
OP_INVOKE_SUPER = 0x6F
OP_INVOKE_DIRECT = 0x70
OP_INVOKE_STATIC = 0x71
OP_INVOKE_INTERFACE = 0x72
OP_INVOKE_VIRTUAL_RANGE = 0x74
OP_INVOKE_SUPER_RANGE = 0x75
OP_INVOKE_DIRECT_RANGE = 0x76
OP_INVOKE_STATIC_RANGE = 0x77
OP_INVOKE_INTERFACE_RANGE = 0x78

OP_NEW_INSTANCE = 0x22
OP_NEW_ARRAY = 0x23
OP_FILLED_NEW_ARRAY = 0x24
OP_FILLED_NEW_ARRAY_RANGE = 0x25

OP_ARRAY_LENGTH = 0x21
OP_INSTANCEOF = 0x20

# 字符串引用表项宽度
WIDTH_BYTE = {0x00, 0x01, 0x04, 0x07, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E,
              0x0F, 0x10, 0x11, 0x12, 0x1D, 0x1E, 0x21, 0x27}
WIDTH_SHORT = set(range(0x02, 0x0E))       # 02..0D: 2 字节
WIDTH_BYTE_EXTRA = {0x0E: 2}# 0x0E return-void: 2 字节（成对）


class CodeItem:
    """⚠️ 性能提示：parse_tries 默认 False。
    旧版把 try_item.handler_off 当绝对偏移读，遇到垃圾数据会做巨量 ULEB 循环，
    是上一轮「全方法扫描慢到崩溃」的元凶；且本工程所有工具都只用 insns，
    所以默认完全跳过 tries 解析。需要时显式 parse_tries=True。
    """

    def __init__(self, data, off, dex, parse_tries=False):
        self.dex = dex
        self.insns = b""
        self.tries = []
        self.tries_size = 0
        self._parse(data, off, parse_tries)

    def _parse(self, data, off, parse_tries):
        (registers_size, ins_size, outs_size, tries_size,
         _debug_off, insns_size) = struct.unpack_from("<HHHHII", data, off)
        self.registers_size = registers_size
        base = off + 16
        self.insns = data[base:base + insns_size * 2]
        self.tries_size = tries_size
        if parse_tries and tries_size > 0:
            # tries 数组紧随 insns（insns_size 为奇数时先补齐 2 字节）
            tbase = base + insns_size * 2
            if insns_size % 2 == 1:
                tbase += 2
            self._parse_tries(data, tbase, tries_size)

    def _parse_tries(self, data, base, tries_size):
        """try_item[] 之后紧跟 encoded_catch_handler_list；
        try_item.handler_off 是相对 handler_list 起点的偏移（非文件绝对偏移）。"""
        items = []
        p = base
        for _ in range(tries_size):
            start, end, handler_off = struct.unpack_from("<III", data, p)
            items.append((start, end, handler_off))
            p += 8
        list_base = p
        for (s, e, hoff) in items:
            try:
                q = list_base + hoff
                size, q = _uleb128(data, q)
                if size > 65535:        # 防御垃圾数据
                    continue
                _sz, q = _uleb128(data, q)
                for _ in range(size):
                    _t, q = _uleb128(data, q)
                    _addr, q = _uleb128(data, q)
                    _h, q = _uleb128(data, q)
                self.tries.append((s, e, hoff))
            except Exception:
                pass


def _uleb128(buf, off):
    r = 0
    sh = 0
    while True:
        b = buf[off]
        off += 1
        r |= (b & 0x7F) << sh
        if not (b & 0x80):
            break
        sh += 7
    return r, off


class MethodRef:
    """方法内的引用序列（简化 IR）"""
    __slots__ = ("kind", "value", "extra")

    def __init__(self, kind, value, extra=None):
        self.kind = kind
        self.value = value
        self.extra = extra

    def __repr__(self):
        return f"{self.kind}:{self.value}"


class MethodBody:
    """方法字节码的解码结果"""

    def __init__(self, cls, name, proto, registers):
        self.cls = cls
        self.name = name
        self.proto = proto
        self.registers = registers
        self.strings = []          # const-string 顺序
        self.methods = []          # invoke 顺序 [(cls, name)]
        self.fields = []           # (cls, type, name)
        self.types = []            # new-instance / const-class
        self.int_consts = []       # int 常量序列（const/4|16|const|high16）
        self.const_calls = []      # (cls, name, const)：invoke 前最近的 int 常量
                                   # —— 用于 protobuf writeTo 字段编号反推
        self.nb_unknown = 0

    def summary(self):
        return (f"{self.cls.split('/')[-1][:-1]}.{self.name}"
                f"  str={len(self.strings)} invoke={len(self.methods)}")


def decode_method(dex: "DexFile", cls_desc: str, mname: str, code: CodeItem):
    """把字节码解成 MethodBody"""
    mb = MethodBody(cls_desc, mname, "", code.registers_size)
    d = dex.d
    ins = code.insns
    n = len(ins)
    p = 0
    pending_const = None            # 最近一个 int 常量（供 invoke 配对）
    while p < n:
        op = ins[p]
        try:
            if op == OP_CONST_STRING:
                idx = struct.unpack_from("<H", ins, p + 2)[0]
                if idx < len(dex.strings):
                    mb.strings.append(dex.strings[idx])
                p += 4
            elif op == OP_CONST_STRING_JUMBO:
                idx = struct.unpack_from("<I", ins, p + 2)[0]
                if idx < len(dex.strings):
                    mb.strings.append(dex.strings[idx])
                p += 6
            elif op == 0x12:                      # const/4  (11n)
                v = ins[p + 1] >> 4
                if v >= 8:
                    v -= 16
                mb.int_consts.append(v)
                pending_const = v
                p += 2
            elif op == 0x13:                      # const/16 (21s)
                v = struct.unpack_from("<h", ins, p + 2)[0]
                mb.int_consts.append(v)
                pending_const = v
                p += 4
            elif op == 0x14:                      # const    (31i)
                v = struct.unpack_from("<i", ins, p + 2)[0]
                mb.int_consts.append(v)
                pending_const = v
                p += 6
            elif op == 0x15:                      # const/high16 (21h)
                v = struct.unpack_from("<h", ins, p + 2)[0] << 16
                mb.int_consts.append(v)
                pending_const = v
                p += 4
            elif op == OP_CONST_CLASS:
                idx = struct.unpack_from("<H", ins, p + 2)[0]
                if idx < len(dex.type_ids):
                    mb.types.append(dex.type_ids[idx])
                p += 4
            elif op == OP_NEW_INSTANCE:
                idx = struct.unpack_from("<H", ins, p + 2)[0]
                if idx < len(dex.type_ids):
                    mb.types.append(dex.type_ids[idx])
                p += 4
            elif op == OP_NEW_ARRAY:
                idx = struct.unpack_from("<H", ins, p + 2)[0]
                if idx < len(dex.type_ids):
                    mb.types.append(dex.type_ids[idx])
                p += 4
            elif 0x6E <= op <= 0x72 or 0x74 <= op <= 0x78:
                idx = struct.unpack_from("<H", ins, p + 2)[0]
                if idx < len(dex.method_ids):
                    mc, mn = dex.method_ids[idx]
                    mb.methods.append((mc, mn))
                    if pending_const is not None:
                        mb.const_calls.append((mc, mn, pending_const))
                pending_const = None
                p += 6
            elif op in (0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x5B):
                idx = struct.unpack_from("<H", ins, p + 2)[0]
                if idx < len(dex.field_ids):
                    mb.fields.append(dex.field_ids[idx])
                p += 4
            elif 0x60 <= op <= 0x6D:
                idx = struct.unpack_from("<H", ins, p + 2)[0]
                if idx < len(dex.field_ids):
                    mb.fields.append(dex.field_ids[idx])
                p += 4
            else:
                p += insn_size(ins, p)
        except Exception:
            mb.nb_unknown += 1
            p += 2
    return mb


# ── 指令宽度表（对照 dalvik bytecode 官方表逐项修正） ─────────────
# ⚠️ 旧版宽度表 const 家族整体错位（0x14 应为 6 字节等），会从含
#    const/16+ 的方法中途走歪 —— 已按官方格式表重写。
_WIDTH_10X = {0x00, 0x0E, 0x3E, 0x3F, 0x40, 0x41, 0x42, 0x43,
              0x73, 0x79, 0x7A} | set(range(0xE3, 0xFA))


def insn_size(ins, p):
    """返回位于 ins[p] 的指令字节宽度（含 payload 伪指令）。"""
    op = ins[p]
    # payload 伪指令：0x00 后跟 ident 01/02/03
    if op == 0x00:
        if p + 1 < len(ins):
            ident = ins[p + 1]
            if ident == 0x01:                       # packed-switch-payload
                size = struct.unpack_from("<H", ins, p + 2)[0]
                return 8 + 4 * size
            if ident == 0x02:                       # sparse-switch-payload
                size = struct.unpack_from("<H", ins, p + 2)[0]
                return 4 + 8 * size
            if ident == 0x03:                       # fill-array-data-payload
                ew = struct.unpack_from("<H", ins, p + 2)[0]
                size = struct.unpack_from("<I", ins, p + 4)[0]
                total = 8 + ew * size
                return total + (total & 1)          # 补齐到偶数字节
        return 2
    if op in _WIDTH_10X or op == 0x12 or (0x0A <= op <= 0x0D) or (0x0F <= op <= 0x11):
        return 2
    if op in (0x01, 0x04, 0x07, 0x21) or 0x7B <= op <= 0x8F or 0xB0 <= op <= 0xCF:
        return 2                                    # 12x 系列
    if op in (0x02, 0x05, 0x08, 0x20, 0x23) or 0x2D <= op <= 0x3D or 0x44 <= op <= 0x51:
        return 4                                    # 22x/23x 系列
    if op in (0x03, 0x06, 0x09):
        return 6                                    # 32x 系列
    if op == 0x13 or op == 0x16 or op == 0x15 or op == 0x19:
        return 4                                    # const/16, const-wide/16, const/high16, const-wide/high16
    if op == 0x14 or op == 0x17:
        return 6                                    # const, const-wide/32
    if op == 0x18:
        return 10                                   # const-wide
    if op == 0x1A or op == 0x1C or op == 0x1F or op == 0x22:
        return 4                                    # 21c: const-string/class, check-cast, new-instance
    if op == 0x1B:
        return 6                                    # const-string/jumbo
    if op == 0x1D or op == 0x1E or op == 0x27 or op == 0x28:
        return 2                                    # 11x / 10t
    if op in (0x24, 0x25) or 0x6E <= op <= 0x72 or 0x74 <= op <= 0x78 or op in (0xFC, 0xFD):
        return 6                                    # 35c / 3rc
    if op in (0x26, 0x2B, 0x2C) or op == 0x29:
        return 6 if op != 0x29 else 4               # fill-array-data(31t), switch(31t→6), goto/16(20t→4)
    if op == 0x2A:
        return 6                                    # goto/32
    if 0x90 <= op <= 0xAF:
        return 4                                    # binop 23x
    if 0x52 <= op <= 0x6D:
        return 4                                    # 22c / 21c（iget/iput/sget/sput）
    if 0xD0 <= op <= 0xE2:
        return 4                                    # binop/lit16, binop/lit8 (22s/22b)
    if op in (0xFA, 0xFB):
        return 8                                    # invoke-polymorphic (45cc/4rcc)
    if op in (0xFE, 0xFF):
        return 4                                    # const-method-handle/type
    return 2                                        # 兜底


def _insn_width(op):
    """旧接口兼容（无字节上下文，仅按 opcode 近似）。"""
    return insn_size(bytes([op]) + b"\x00" * 12, 0)