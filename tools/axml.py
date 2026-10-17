#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
axml.py —— 零依赖 Android 二进制 XML (AXML) 解析器

用途：读 AndroidManifest.xml 与 res/xml/*.xml，取出：
  - 全部 activity / service / receiver + intent-filter（action / category / data）
  - 全部 meta-data（key → value）
  - 全部 uses-permission
  - extras 契约（deep link 需要的 extra key）

AXML 结构：
  header: u32 magic(0x00080003) + u32 size
  然后 chunk 序列：string pool / resource map / namespace / start-element / end-element / cdata
"""
import struct


def _utf16_to_py(b):
    return b.decode("utf-16-le", errors="replace")


class StringPool:
    def __init__(self, data, off):
        self.strings = []
        self._parse(data, off)

    def _parse(self, data, off):
        (_type, _hdr_size, chunk_size) = struct.unpack_from("<HHI", data, off)
        (string_count, _style_count, _flags, strings_start, _styles_start) = struct.unpack_from(
            "<IIIII", data, off + 8
        )
        is_utf8 = bool(_flags & (1 << 8))
        base = off + strings_start
        offsets = struct.unpack_from("<%dI" % string_count, data, off + 28)
        for so in offsets:
            p = base + so
            try:
                if is_utf8:
                    # UTF-8: u8 utf16len (可能 2 字节), u8 bytelen, 可能是 2 字节长度
                    n = data[p]
                    p += 1
                    if n & 0x80:
                        n = ((n & 0x7F) << 8) | data[p]
                        p += 1
                    ln = data[p]
                    p += 1
                    if ln & 0x80:
                        ln = ((ln & 0x7F) << 8) | data[p]
                        p += 1
                    s = data[p:p + ln].decode("utf-8", errors="replace")
                else:
                    ln = struct.unpack_from("<H", data, p)[0]
                    if ln & 0x8000:
                        ln2 = struct.unpack_from("<H", data, p + 2)[0]
                        ln = ((ln & 0x7FFF) << 16) | ln2
                        p += 4
                    else:
                        p += 2
                    s = _utf16_to_py(data[p:p + ln * 2])
                self.strings.append(s)
            except Exception:
                self.strings.append("")

    def get(self, idx):
        if 0 <= idx < len(self.strings):
            return self.strings[idx]
        return f"?{idx}?"

    def find(self, needle):
        return [s for s in self.strings if needle in s]


# XML 事件类型
START_NS = 0x0100
END_NS = 0x0101
START_EL = 0x0102
END_EL = 0x0103
CDATA = 0x0104


class AXML:
    """解析后的 AXML，提供简易遍历接口"""

    def __init__(self, data):
        self.data = data
        self.pool = None
        self.events = []  # (type, tag, attrs{ns,name,value}, depth)
        self._parse()

    def _parse(self):
        data = self.data
        if struct.unpack_from("<I", data, 0)[0] != 0x00080003:
            raise ValueError("不是 AXML (magic=%08x)" % struct.unpack_from("<I", data, 0)[0])
        off = struct.unpack_from("<I", data, 4)[0]  # 跳过头部
        depth = 0
        # 预扫描找 string pool
        p = 8
        while p < len(data):
            (ctype, _hs, csize) = struct.unpack_from("<HHI", data, p)
            if csize == 0:
                break
            if ctype == 0x0001 and self.pool is None:
                self.pool = StringPool(data, p)
            elif ctype == START_EL:
                # startElement: lineNumber(i) comment(i) ns(i) name(i)
                #                attributeStart(H) attributeSize(H) attributeCount(H)
                #                idIndex(H) classIndex(H) styleIndex(H)
                (_sln, _cmt, _ns, _name,
                 _attr_start, _attr_size, _attr_count,
                 _id_idx, _class_idx, _style_idx) = struct.unpack_from("<iiiiHHHHHH", data, p + 8)
                sp = self.pool
                tag = sp.get(_name) if sp else "?"
                attrs = {}
                base = p + 16 + _attr_start
                for i in range(_attr_count):
                    ao = base + i * _attr_size
                    if _attr_size < 20:
                        break
                    a_ns, a_name, a_raw = struct.unpack_from("<iii", data, ao)
                    a_type = data[ao + 15]
                    a_val = struct.unpack_from("<I", data, ao + 16)[0] if _attr_size >= 20 else 0
                    key = sp.get(a_name) if sp else f"@{a_name}"
                    if a_type == 0x03:  # STRING
                        v = sp.get(a_val)
                    elif a_type == 0x01:  # REFERENCE
                        v = f"@0x{a_val:08x}"
                    elif a_type == 0x10:  # INT_DEC
                        v = str(a_val)
                    elif a_type == 0x11:  # INT_HEX
                        v = f"0x{a_val:x}"
                    elif a_type == 0x12:  # BOOLEAN
                        v = str(bool(a_val))
                    else:
                        v = sp.get(a_val) if a_type == 0x03 else f"0x{a_val:x}"
                    attrs[key] = v
                self.events.append((START_EL, tag, attrs, depth))
                depth += 1
            elif ctype == END_EL:
                depth -= 1
                _name = struct.unpack_from("<i", data, p + 20)[0]
                self.events.append((END_EL, self.pool.get(_name) if self.pool else "?", {}, depth))
            p += csize

    def iter_start(self):
        for t, tag, attrs, d in self.events:
            if t == START_EL:
                yield tag, attrs, d

    def dump(self, indent_max=99):
        out = []
        for t, tag, attrs, d in self.events:
            if t == END_EL:
                continue
            pad = "  " * min(d, indent_max)
            if not attrs:
                out.append(f"{pad}<{tag}>")
            else:
                a = " ".join(f'{k}="{v}"' for k, v in attrs.items())
                out.append(f"{pad}<{tag} {a}>")
        return "\n".join(out)

    def dump_tag(self, tagname):
        """只导出某个 tag 及其子树（深度相对）"""
        out = []
        active = False
        base = 0
        for t, tag, attrs, d in self.events:
            if t == END_EL:
                if active and d <= base:
                    active = False
                continue
            if tag == tagname and not active:
                active = True
                base = d
            if active:
                pad = "  " * (d - base)
                if not attrs:
                    out.append(f"{pad}<{tag}>")
                else:
                    a = " ".join(f'{k}="{v}"' for k, v in attrs.items())
                    out.append(f"{pad}<{tag} {a}>")
        return "\n".join(out)


def read_manifest(apk_path, entry="AndroidManifest.xml"):
    import zipfile
    with zipfile.ZipFile(apk_path) as z:
        data = z.read(entry)
    return AXML(data)