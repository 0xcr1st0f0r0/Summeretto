#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extmap.py —— 全 APK 的 protobuf 扩展(extension)注册表。

Google 内部协议大量使用 proto2 extensions 承载载荷，例如：
    ProcessQueryRequest { extensions 1000 to max; }
真实请求体是扩展 #1000（类型 Lgcvm）。

注册代码固定形态：
    sget-object  v0, Lgcvp;->a:Lgcvp;                 // 被扩展的容器默认实例
    sget-object  v5, Lgohl;->s:Lgohl;                 // WireFormat.FieldType
    const/4      v3, #0                               // enumTypeMap = null
    const/16     v4, #+1000                           // ★ 扩展字段号
    move-object  v2, v1                               // messageDefaultInstance
    const-class  v6, Lgcvm;                           // 值类型
    invoke-static/range {v0..v6}, Lgoep;->newSingularGeneratedExtension(...)
    sput-object  v0, Lgcvm;->b:Lgoen;

本工具用「前向寄存器数据流」还原成表：(容器消息, 扩展号, 值类型, FieldType, 注册类)

用法:
  python tools/extmap.py apk/AGSA_17.66.12.xapk --out out/robin/extension-map.txt
  python tools/extmap.py apk/... --contains "^Lgcvp;$"
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

EXT_METHODS = {"newSingularGeneratedExtension", "newRepeatedGeneratedExtension"}
DEF_OPS = {0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B,
           0x1C, 0x22, 0x23, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
           0x07, 0x08, 0x09}


def load_all(path, only=None):
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
                out.append((dn, DexFile(inner.read(dn), dn)))
            inner.close()
    else:
        for dn in sorted(n for n in entries if re.match(r"^classes\d*\.dex$", n)):
            if only and dn not in only:
                continue
            out.append((dn, DexFile(z.read(dn), dn)))
    z.close()
    return out


def decode_insns(dex, coff):
    """返回 [{addr, op, w, regs, target(kind,value)}]。"""
    ins = CodeItem(dex.d, coff, dex).insns
    out = []
    p = 0
    n = len(ins)
    while p + 2 <= n:
        op = ins[p]
        w = insn_size(ins, p)
        item = {"addr": p, "op": op, "w": w, "regs": [], "target": None}
        try:
            if op == 0x12:                                   # const/4
                B = ins[p + 1] >> 4
                item["target"] = ("int", B - 16 if B >= 8 else B)
                item["regs"] = [ins[p + 1] & 0xF]
            elif op in (0x13, 0x16):                         # const/16, const-wide/16
                item["target"] = ("int", struct.unpack_from("<h", ins, p + 2)[0])
                item["regs"] = [ins[p + 1]]
            elif op in (0x15, 0x19):                         # const/high16, const-wide/high16
                item["target"] = ("int", struct.unpack_from("<h", ins, p + 2)[0] << 16)
                item["regs"] = [ins[p + 1]]
            elif op in (0x14, 0x17):                         # const, const-wide/32
                item["target"] = ("int", struct.unpack_from("<i", ins, p + 2)[0])
                item["regs"] = [ins[p + 1]]
            elif op == 0x1A:                                 # const-string
                si = struct.unpack_from("<H", ins, p + 2)[0]
                item["target"] = ("str", dex.strings[si] if si < len(dex.strings) else "?")
                item["regs"] = [ins[p + 1]]
            elif op == 0x1B:                                 # const-string/jumbo
                si = struct.unpack_from("<I", ins, p + 2)[0]
                item["target"] = ("str", dex.strings[si] if si < len(dex.strings) else "?")
                item["regs"] = [ins[p + 1]]
            elif op == 0x1C:                                 # const-class
                ti = struct.unpack_from("<H", ins, p + 2)[0]
                item["target"] = ("class", dex.type_ids[ti] if ti < len(dex.type_ids) else "?")
                item["regs"] = [ins[p + 1]]
            elif op == 0x22:                                 # new-instance
                ti = struct.unpack_from("<H", ins, p + 2)[0]
                item["target"] = ("new", dex.type_ids[ti] if ti < len(dex.type_ids) else "?")
                item["regs"] = [ins[p + 1]]
            elif 0x60 <= op <= 0x6D:                         # sget*/sput*
                fi = struct.unpack_from("<H", ins, p + 2)[0]
                fc, ft, fn = dex.field_ids[fi] if fi < len(dex.field_ids) else ("?", "?", "?")
                item["target"] = ("sget" if op < 0x68 else "sput", f"{fc}->{fn}:{ft}")
                item["regs"] = [ins[p + 1]]
            elif op == 0x01:                                 # move (12x): B|A
                item["target"] = ("move", None)
                item["regs"] = [ins[p + 1] & 0xF, ins[p + 1] >> 4]
            elif op == 0x07:                                 # move-object (12x)
                item["target"] = ("move", None)
                item["regs"] = [ins[p + 1] & 0xF, ins[p + 1] >> 4]
            elif op == 0x02:                                 # move/from16 (22x)
                a1 = struct.unpack_from("<H", ins, p + 2)[0]
                item["target"] = ("move", None)
                item["regs"] = [a1, ins[p + 1]]
            elif op == 0x08:                                 # move-object/from16 (22x)
                a1 = struct.unpack_from("<H", ins, p + 2)[0]
                item["target"] = ("move", None)
                item["regs"] = [a1, ins[p + 1]]
            elif 0x6E <= op <= 0x72:                         # invoke 35c
                mi = struct.unpack_from("<H", ins, p + 2)[0]
                w0 = struct.unpack_from("<H", ins, p)[0]
                cnt = (w0 >> 12) & 0xF
                b4, b5 = ins[p + 4], ins[p + 5]
                rl = [b4 & 0xF, b4 >> 4, b5 & 0xF, b5 >> 4]
                rl = (rl + [(w0 >> 8) & 0xF]) if cnt == 5 else rl[:cnt]
                item["regs"] = rl
                if mi < len(dex.method_ids):
                    mc, mn = dex.method_ids[mi]
                    item["target"] = ("invoke", f"{mc}->{mn}")
            elif 0x74 <= op <= 0x78:                        # invoke 3rc
                mi = struct.unpack_from("<H", ins, p + 2)[0]
                cnt = ins[p + 1]
                first = struct.unpack_from("<H", ins, p + 4)[0]
                item["regs"] = list(range(first, first + cnt))
                if mi < len(dex.method_ids):
                    mc, mn = dex.method_ids[mi]
                    item["target"] = ("invoke", f"{mc}->{mn}")
        except Exception:
            pass
        out.append(item)
        p += w
    return out


def analyze_method(dex, coff, cls_desc, mname, out_rows):
    """单次前向数据流：维护 寄存器 → 定值，遇到扩展注册 invoke 就快照。"""
    items = decode_insns(dex, coff)
    vals = {}
    for it in items:
        tgt = it["target"]
        if tgt is None:
            continue
        kind, val = tgt
        if kind == "invoke":
            if val.split("->")[-1] in EXT_METHODS:
                regs = it["regs"]
                if len(regs) >= 7:
                    def g(i):
                        v = vals.get(regs[i])
                        return v[1] if v else "?"
                    out_rows.append({
                        "cls": cls_desc, "reg_method": mname,
                        "kind": val.split("->")[-1],
                        "container": g(0), "default": g(1), "mdefault": g(2),
                        "enummap": g(3), "num": g(4), "ftype": g(5), "vtype": g(6),
                    })
            continue
        if kind == "sget":
            for r in it["regs"]:
                vals[r] = ("sget", val)
        elif kind == "new":
            for r in it["regs"]:
                vals[r] = ("new", val)
        elif kind == "move":
            src, dst = it["regs"][0], it["regs"][1]
            if src in vals:
                vals[dst] = vals[src]
        elif kind == "sput":
            pass
        else:
            for r in it["regs"]:
                vals[r] = (kind, val)
    return out_rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--contains", default=None, help="只看容器类正则匹配的扩展")
    ap.add_argument("--value", default=None, help="只看值类型正则匹配的扩展")
    ap.add_argument("--dex", default=None)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    crx = re.compile(a.contains) if a.contains else None
    vrx = re.compile(a.value) if a.value else None
    only = set(a.dex.split(",")) if a.dex else None

    rows = []
    for dn, dex in load_all(a.path, only):
        for ci, cdesc in enumerate(dex.class_defs):
            cd = dex.iter_class_data(ci)
            if not cd:
                continue
            for (midx, acc, coff) in cd[0] + cd[1]:
                if not coff:
                    continue
                analyze_method(dex, coff, cdesc, dex.method_ids[midx][1], rows)

    seen = set()
    uniq = []
    for r in rows:
        k = (r["num"], r["container"], r["vtype"])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(r)

    lines = [f"# protobuf 扩展注册表（原始 {len(rows)} 条 / 去重 {len(uniq)} 条）",
             "# 扩展号 | 容器消息 | 值类型 | FieldType | 注册类.方法"]
    for r in sorted(uniq, key=lambda x: (str(x["container"]), str(x["num"]))):
        cont, vt = str(r["container"]), str(r["vtype"])
        if crx and not crx.search(cont):
            continue
        if vrx and not vrx.search(vt):
            continue
        ft = str(r["ftype"])
        lines.append(f"{r['num']!s:>10} | {cont.split('/')[-1].rstrip(';'):<24} | "
                     f"{vt.split('/')[-1].rstrip(';'):<24} | "
                     f"{ft.split('->')[-1].split('/')[-1]:<28} | "
                     f"{r['cls'].split('/')[-1].rstrip(';')}.{r['reg_method']}")
    txt = "\n".join(lines)
    print(txt[:8000])
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(txt + "\n")
        print(f"\n[+] 已写入 {a.out}（{len(lines) - 2} 条）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
