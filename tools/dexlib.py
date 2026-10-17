#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dexlib.py —— 零依赖 Android 静态分析工具箱

设计约束：本机 D 盘仅剩 20GB，不安装 jadx/apktool/dexdump（百MB级）。
本模块只做「字符串 + 类名 + 方法引用」层面的提取，正好覆盖阶段1的
端点字符串扫描需求，产出足以反推 gRPC service/method 与 payload 构造。

用法:
    from dexlib import DexFile, scan_strings
"""
import io
import os
import re
import struct
import zipfile
from collections import defaultdict

# ── DEX 常量池 item type ───────────────────────────────────────────
TYPE_HEADER_ITEM = 0x0000
TYPE_STRING_ID_ITEM = 0x0001
TYPE_TYPE_ID_ITEM = 0x0002
TYPE_PROTO_ID_ITEM = 0x0003
TYPE_FIELD_ID_ITEM = 0x0004
TYPE_METHOD_ID_ITEM = 0x0005
TYPE_CLASS_DEF_ITEM = 0x0006
TYPE_MAP_LIST = 0x1000
TYPE_TYPE_LIST = 0x1001
TYPE_ANNOTATION_SET_ITEM = 0x2000
TYPE_CODE_ITEM = 0x2001
TYPE_CLASS_DATA_ITEM = 0x2002
TYPE_DEBUG_INFO_ITEM = 0x2003
TYPE_ANNOTATION_ITEM = 0x2004
TYPE_ENCODED_ARRAY_ITEM = 0x2005
TYPE_ANNOTATIONS_DIRECTORY_ITEM = 0x2006

# type_id 描述符 -> 内部 shorty/type code（仅用于 proto 识别时排除噪音）
PRIMITIVES = set("VZBCSIJFD")


def uleb128(buf, off):
    """读 ULEB128，返回 (value, new_offset)"""
    result = 0
    shift = 0
    while True:
        b = buf[off]
        off += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    return result, off


def mutf8_units(raw):
    """把 DEX 的 MUTF-8 字节串解成 **UTF-16 码元列表**。

    ⚠️ 为什么不能直接用 bytes.decode("utf-8")：
      DEX 的 MUTF-8 允许「孤立的代理码元」D800..DFFF（按 CESU-8 风格存成
      3 字节 ED xx xx），而标准 UTF-8 禁止代理码元。Python 会判非法 → 替换成
      U+FFFD，数据直接毁掉。
      这对本工程是致命的：protobuf-javalite 的 RawMessageInfo「info 字符串」
      正是用 D800..DFFF 当 >13bit 数值的续接标记（见 tools/fieldmap.py）。
    另外 DEX 用 C0 80 编码 U+0000，遇到真正的 00 字节则结束。
    """
    units = []
    i = 0
    n = len(raw)
    while i < n:
        b = raw[i]
        if b == 0:
            break
        if b < 0x80:
            units.append(b)
            i += 1
        elif (b & 0xE0) == 0xC0:
            if i + 1 >= n:
                break
            units.append(((b & 0x1F) << 6) | (raw[i + 1] & 0x3F))
            i += 2
        elif (b & 0xF0) == 0xE0:
            if i + 2 >= n:
                break
            units.append(((b & 0x0F) << 12) | ((raw[i + 1] & 0x3F) << 6) | (raw[i + 2] & 0x3F))
            i += 3
        elif (b & 0xF8) == 0xF0:      # 4 字节（MUTF-8 非标准但 Android 偶见）→ 拆成代理对
            if i + 3 >= n:
                break
            cp = (((b & 0x07) << 18) | ((raw[i + 1] & 0x3F) << 12)
                  | ((raw[i + 2] & 0x3F) << 6) | (raw[i + 3] & 0x3F))
            cp -= 0x10000
            units.append(0xD800 | (cp >> 10))
            units.append(0xDC00 | (cp & 0x3FF))
            i += 4
        else:
            break
    return units


def units_to_str(units):
    """码元列表 → 可打印 str。
    正常 BMP 码元原样保留；孤立代理码元（javalite info 字符串的续接标记）
    在显示时替换成 U+FFFD，避免污染终端 / 文件写出。"""
    out = []
    i = 0
    n = len(units)
    while i < n:
        u = units[i]
        if 0xD800 <= u <= 0xDBFF and i + 1 < n and 0xDC00 <= units[i + 1] <= 0xDFFF:
            cp = 0x10000 + ((u - 0xD800) << 10) + (units[i + 1] - 0xDC00)
            out.append(chr(cp))
            i += 2
        elif 0xD800 <= u <= 0xDFFF:
            out.append("\ufffd")
            i += 1
        else:
            out.append(chr(u))
            i += 1
    return "".join(out)


class DexFile:
    """解析单个 classes*.dex"""

    def __init__(self, data: bytes, name: str = "classes.dex"):
        self.name = name
        self.d = data
        self.strings = []
        self.type_ids = []
        self.proto_ids = []
        self.proto_params = []
        self.field_ids = []
        self.method_ids = []
        self.method_protos = []
        self.class_defs = []
        self.class_supers = []
        self.class_ifaces = []
        self._parse()

    def _parse(self):
        d = self.d
        if d[:4] != b"dex\n":
            raise ValueError(f"{self.name}: 不是合法 DEX (magic={d[:4]!r})")
        (string_ids_size,) = struct.unpack_from("<I", d, 56)
        (string_ids_off,) = struct.unpack_from("<I", d, 60)
        (type_ids_size,) = struct.unpack_from("<I", d, 64)
        (type_ids_off,) = struct.unpack_from("<I", d, 68)
        (proto_ids_size,) = struct.unpack_from("<I", d, 72)
        (proto_ids_off,) = struct.unpack_from("<I", d, 76)
        (field_ids_size,) = struct.unpack_from("<I", d, 80)
        (field_ids_off,) = struct.unpack_from("<I", d, 84)
        (method_ids_size,) = struct.unpack_from("<I", d, 88)
        (method_ids_off,) = struct.unpack_from("<I", d, 92)
        (class_defs_size,) = struct.unpack_from("<I", d, 96)
        (class_defs_off,) = struct.unpack_from("<I", d, 100)

        self._parse_strings(string_ids_size, string_ids_off)
        self._parse_types(type_ids_size, type_ids_off)
        self._parse_protos(proto_ids_size, proto_ids_off)
        self._parse_fields(field_ids_size, field_ids_off)
        self._parse_methods(method_ids_size, method_ids_off)
        self._parse_classes(class_defs_size, class_defs_off)

    def _parse_strings(self, size, off):
        d = self.d
        self.string_offsets = []    # 每个字符串的 data 偏移（惰性精确解码用）
        for i in range(size):
            (data_off,) = struct.unpack_from("<I", d, off + i * 4)
            self.string_offsets.append(data_off)
            # MUTF-8: uleb128 utf16_size 然后以 00 结尾的 MUTF-8 字节
            _, p = uleb128(d, data_off)
            end = d.find(b"\x00", p)
            self.strings.append(units_to_str(mutf8_units(d[p:end])))

    def units_at(self, idx):
        """按需精确解码第 idx 个字符串的 UTF-16 码元列表。

        ⚠️ 必需：protobuf-javalite 的 RawMessageInfo「info 字符串」用
        D800..DFFF 当续接标记，dex.strings[idx] 里的代理码元已被显示层
        替换掉了，只有这里能拿到真值。
        不做全量缓存（14 个 dex 会吃掉几百 MB）。
        """
        if idx < 0 or idx >= len(self.string_offsets):
            return []
        d = self.d
        _, p = uleb128(d, self.string_offsets[idx])
        end = d.find(b"\x00", p)
        return mutf8_units(d[p:end])

    def _parse_types(self, size, off):
        d = self.d
        for i in range(size):
            (idx,) = struct.unpack_from("<I", d, off + i * 4)
            self.type_ids.append(self.strings[idx] if idx < len(self.strings) else "?")

    def _parse_protos(self, size, off):
        d = self.d
        for i in range(size):
            b = off + i * 12
            (shorty_idx, ret_idx, params_off) = struct.unpack_from("<III", d, b)
            shorty = self.strings[shorty_idx] if shorty_idx < len(self.strings) else ""
            ret = self.type_ids[ret_idx] if ret_idx < len(self.type_ids) else ""
            self.proto_ids.append((shorty, ret))
            self.proto_params.append(self._type_list(params_off))

    def _type_list(self, off):
        """type_list: uint32 size + size * uint16 type_idx"""
        if not off or off + 4 > len(self.d):
            return ()
        (size,) = struct.unpack_from("<I", self.d, off)
        if size > 4096:
            return ()
        out = []
        for i in range(size):
            (ti,) = struct.unpack_from("<H", self.d, off + 4 + i * 2)
            out.append(self.type_ids[ti] if ti < len(self.type_ids) else "?")
        return tuple(out)

    def _parse_fields(self, size, off):
        d = self.d
        for i in range(size):
            (cls_idx, type_idx, name_idx) = struct.unpack_from("<HHI", d, off + i * 8)
            self.field_ids.append(
                (
                    self.type_ids[cls_idx] if cls_idx < len(self.type_ids) else "?",
                    self.type_ids[type_idx] if type_idx < len(self.type_ids) else "?",
                    self.strings[name_idx] if name_idx < len(self.strings) else "?",
                )
            )

    def _parse_methods(self, size, off):
        d = self.d
        for i in range(size):
            (cls_idx, proto_idx, name_idx) = struct.unpack_from("<HHI", d, off + i * 8)
            self.method_ids.append(
                (
                    self.type_ids[cls_idx] if cls_idx < len(self.type_ids) else "?",
                    self.strings[name_idx] if name_idx < len(self.strings) else "?",
                )
            )
            self.method_protos.append(proto_idx)

    def msig(self, midx):
        """渲染方法完整签名： 类.名(参数):返回"""
        if midx >= len(self.method_ids):
            return "?"
        cls, name = self.method_ids[midx]
        pid = self.method_protos[midx] if midx < len(self.method_protos) else -1
        if 0 <= pid < len(self.proto_ids):
            params = self.proto_params[pid] if pid < len(self.proto_params) else ()
            ret = self.proto_ids[pid][1]
            return f"{cls}.{name}({''.join(p for p in params)}):{ret}"
        return f"{cls}.{name}"

    def mret(self, midx):
        pid = self.method_protos[midx] if midx < len(self.method_protos) else -1
        if 0 <= pid < len(self.proto_ids):
            return self.proto_ids[pid][1]
        return "?"

    def _parse_classes(self, size, off):
        d = self.d
        self.class_data_offs = []
        self.class_supers = []
        self.class_ifaces = []
        for i in range(size):
            b = off + i * 32
            (class_idx, _flags, _super, _ifaces, _src, _ann,
             class_data_off, _static) = struct.unpack_from("<IIIIIIII", d, b)
            self.class_defs.append(
                self.type_ids[class_idx] if class_idx < len(self.type_ids) else "?"
            )
            self.class_data_offs.append(class_data_off)
            self.class_supers.append(
                self.type_ids[_super] if _super < len(self.type_ids) else "?"
            )
            self.class_ifaces.append(self._type_list(_ifaces))

    def iter_class_data(self, idx):
        """解析一个 class_data_item，返回 (direct_methods, virtual_methods)。

        每项为 3 元组 (method_idx, access_flags, code_off)。
        ⚠️ encoded_method 只有 3 个 ULEB 字段（idx_diff / access_flags / code_off）。
        旧版本多读了一个 ULEB，导致从每类第 2 个方法起全部错位 —— 已修复。
        仅在需要时调用（懒解析，避免全量开销）。
        """
        off = self.class_data_offs[idx]
        if off == 0:
            return None
        d = self.d
        p = off

        def uleb(buf, o):
            r = 0
            sh = 0
            while True:
                b = buf[o]
                o += 1
                r |= (b & 0x7F) << sh
                if not (b & 0x80):
                    break
                sh += 7
            return r, o

        sf, p = uleb(d, p)
        inf, p = uleb(d, p)
        dm, p = uleb(d, p)
        vm, p = uleb(d, p)

        def read_fields(o, n):
            idx_ = 0
            out = []
            for _ in range(n):
                diff, o = uleb(d, o)
                acc, o = uleb(d, o)
                idx_ += diff
                out.append((idx_, acc))
            return o, out

        p, sfields = read_fields(p, sf)
        p, ifields = read_fields(p, inf)
        self._last_fields = (sfields, ifields)

        def read_methods(o, n):
            out = []
            midx = 0
            for _ in range(n):
                d_, o = uleb(d, o)
                acc, o = uleb(d, o)
                co, o = uleb(d, o)
                midx += d_
                out.append((midx, acc, co))
            return o, out

        p, direct = read_methods(p, dm)
        p, virtual = read_methods(p, vm)
        return (direct, virtual)

    def class_fields(self, idx):
        """返回 (static_fields, instance_fields)：[(类,类型,名,acc)]。
        注意：这是「声明字段」，与 dumpclass 里打印的「被访问字段」不同。
        protobuf 消息的数据字段就靠它才看得见（访问器常被 R8 删掉）。"""
        if self.iter_class_data(idx) is None:
            return ([], [])
        sf, inf = self._last_fields
        out = []
        for grp in (sf, inf):
            lst = []
            for (fi, acc) in grp:
                if fi < len(self.field_ids):
                    c, t, n = self.field_ids[fi]
                    lst.append((c, t, n, acc))
                else:
                    lst.append(("?", "?", "?", acc))
            out.append(lst)
        return tuple(out)

    # ── 便捷视图 ───────────────────────────────────────────────
    def iter_all_strings(self):
        return self.strings

    def iter_all_types(self):
        return self.type_ids

    def iter_methods(self):
        """(类描述符, 方法名)"""
        return self.method_ids

    def iter_fields(self):
        return self.field_ids

    def iter_classes(self):
        return self.class_defs


# ── APK 处理 ────────────────────────────────────────────────────

def list_apk(path):
    """列出 APK 内文件与体积"""
    out = []
    with zipfile.ZipFile(path) as z:
        for i in z.infolist():
            out.append((i.filename, i.file_size, i.compress_size))
    return out


def find_dex(apk_path):
    """返回 APK 内所有 classes*.dex 的 (名称, 大小)"""
    return [(n, s) for n, s, _ in list_apk(apk_path) if re.match(r"^classes\d*\.dex$", n)]


def extract_entry(apk_path, entry, out_path):
    with zipfile.ZipFile(apk_path) as z:
        data = z.read(entry)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(data)
    return len(data)


def load_dexes(apk_path, verbose=True):
    """从 APK 加载全部 classes*.dex"""
    dexes = []
    with zipfile.ZipFile(apk_path) as z:
        names = sorted(
            n for n in z.namelist() if re.match(r"^classes\d*\.dex$", n)
        )
        for n in names:
            data = z.read(n)
            try:
                dex = DexFile(data, n)
                dexes.append(dex)
                if verbose:
                    print(
                        f"  [dex] {n:20} {len(data)/1024/1024:7.2f}MB "
                        f"strings={len(dex.strings):7} types={len(dex.type_ids):6} "
                        f"methods={len(dex.method_ids):7} classes={len(dex.class_defs):6}"
                    )
            except Exception as e:
                if verbose:
                    print(f"  [dex] {n}: 解析失败 {e}")
    return dexes


# ── 端点/协议扫描规则 ────────────────────────────────────────────

# gRPC full-method-name 形态: /package.Service/Method
RE_GRPC_METHOD = re.compile(r"^/[a-zA-Z_][\w.]*\.[A-Z][\w$]*/[A-Z][\w$]*$")
# proto full name: package.Message
RE_PROTO_FULL = re.compile(r"^[a-z][\w]*(\.[a-z][\w]*)*\.[A-Z][\w$]*$")
# URL 路径
RE_URL = re.compile(r"^/[a-zA-Z0-9_\-/.]{4,120}$")
# batchexecute 风格 RPC id (十进制字符串)
RE_RPC_ID = re.compile(r"^[A-Za-z0-9_\-]{4,}$")

INTEREST_MIME = {
    # 视频
    "video/mp4", "video/mpeg", "video/quicktime", "video/x-matroska", "video/webm",
    "video/3gpp", "video/x-msvideo", "video/avi", "video/mp2t", "video/x-m4v",
    # 音频
    "audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/opus", "audio/wav",
    "audio/x-wav", "audio/webm", "audio/flac", "audio/amr", "audio/3gpp", "audio/midi",
    # 图片
    "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif",
    "image/avif", "image/bmp",
}


def classify(s):
    """给字符串打标签"""
    tags = []
    if RE_GRPC_METHOD.match(s):
        tags.append("GRPC_METHOD")
    if RE_PROTO_FULL.match(s) and "." in s:
        tags.append("PROTO")
    if s.startswith("http://") or s.startswith("https://"):
        tags.append("URL")
    if RE_URL.match(s) and "/" in s[1:]:
        tags.append("PATH")
    if s.lower() in INTEREST_MIME:
        tags.append("MIME")
    if "batchexecute" in s:
        tags.append("BATCHEXECUTE")
    if "contrib_service" in s or "push.clients6" in s or "content-push" in s:
        tags.append("UPLOAD")
    return tags


def scan(dexes, patterns=None, min_len=4):
    """
    扫描全部字符串，命中 patterns 中任一正则即收集
    返回 {pattern_name: [(string, dex_name, tag)]}
    """
    patterns = patterns or {}
    res = {k: [] for k in patterns}
    for dex in dexes:
        for s in dex.strings:
            if len(s) < min_len:
                continue
            tags = classify(s)
            for name, rx in patterns.items():
                if rx.search(s):
                    res[name].append((s, dex.name, ",".join(tags)))
    return res


DEFAULT_PATTERNS = {
    "GRPC": re.compile(r"^[a-z][\w]*(\.[a-z][\w]*)*\.[A-Z][\w$]*/[A-Z][\w$]*$"),
    "GRPC_KNOWN": re.compile(
        r"(batches|GenerateContent|StreamGenerate|SendMessage|UploadFile|"
        r"CreateUpload|MediaUpload|Assistant|Robin|Bonobo|Bard)", re.I),
    "PROTO_MSG": re.compile(
        r"^[a-z][\w]*(\.[a-z][\w]*)*\.(Message|Request|Response|Input|Output|"
        r"Blob|Media|Attachment|Video|Audio|FilePart|Part|Content|Chunk)\w*$"),
    "BATCHEXECUTE": re.compile(r"batchexecute|rpcids|RPC_ID", re.I),
    "UPLOAD": re.compile(
        r"contrib_service|push\.clients6|content-push|resumable|"
        r"X-Goog-Upload|bard-storage|Upload-Protocol", re.I),
    "GOOGLE_API": re.compile(
        r"googleapis\.com|google\.com/(upload|contrib|async)|"
        r"alkalimakersuite|pa.googleapis", re.I),
    "VIDEO_MIME": re.compile(
        r"video/(mp4|mpeg|quicktime|x-matroska|webm|3gpp|x-msvideo|mp2t|x-m4v)", re.I),
    "AUDIO_MIME": re.compile(
        r"audio/(mpeg|mp4|aac|ogg|opus|wav|x-wav|webm|flac|amr|3gpp)", re.I),
    "AUTH": re.compile(
        r"ya29\.|aas_et/|gpsoauth|master.?token|oauth2|SAPISID|Authorization", re.I),
    "FEATURE_GATE": re.compile(
        r"FEATURE_MODE_|Robin|Bonobo|#bnb#|assistant.?surface", re.I),
}