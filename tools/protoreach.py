#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
protoreach.py —— protobuf 消息「可达对象图」BFS（阶段2 附件定位用）

背景：
  AGSA 的 Robin 协议里，ProcessQueryRequest 是一个 **空消息 + 扩展** 的
  proto2 信封（javavlite ExtendableMessage），载荷全在扩展里；扩展值又是
  普通消息，字段里再嵌别的消息。想找「视频附件在哪个字段」靠手工一个个
  dumpclass 太低效。

做法：
  1. 解析 tools/extmap.py 产出的 out/robin/extension-map.txt 得到
     {容器类: [(扩展号, 值类型)]}
  2. 从根类开始 BFS：
       普通字段 MESSAGE/MESSAGE_LIST/ONEOF<MESSAGE> → 递归
       容器类是 ExtendableMessage → 同时展开它的全部扩展值类型
  3. 每个类打印字段表（字段号/类型/Java 字段名/声明类型）

输出形如：
  ProcessQueryRequest (Lgcvp;)
  ├─ [ext 1000] Lgcvm;
  │   ├─ #1 MESSAGE d : Lgauy;
  ...

用法:
  python tools/protoreach.py apk/AGSA_17.66.12.xapk --root "^Lgcvp;$" --depth 4
"""
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fieldmap import load_dexes, extract_message_info, decode_field_table, type_name  # noqa
from codeitem import CodeItem  # noqa

MSG_TYPES = {"MESSAGE", "GROUP", "MESSAGE_LIST", "GROUP_LIST"}


def load_extmap(path):
    """extension-map.txt → {container: [(num, value_type)]}"""
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for ln in f:
            parts = [p.strip() for p in ln.split("|")]
            if len(parts) < 5:
                continue
            try:
                num = int(parts[0])
            except ValueError:
                continue
            cfield = parts[1]          # Lgcvm;->a:Lgcvm
            vtype = parts[2]
            m = re.match(r"^(\w+);->", cfield)
            if not m:
                continue
            container = m.group(1) + ";"
            out.setdefault(container, []).append((num, vtype))
    return out


class ProtoDB:
    def __init__(self, path):
        self.dexes = load_dexes(path, None)
        self.index = {}          # cdesc -> (dex, ci)
        for _iname, _dn, dex in self.dexes:
            for ci, c in enumerate(dex.class_defs):
                self.index.setdefault(c, (dex, ci))
        self.cache = {}

    def table(self, cdesc):
        """返回 (header, fields) 或 None"""
        if cdesc in self.cache:
            return self.cache[cdesc]
        ent = self.index.get(cdesc)
        res = None
        if ent:
            dex, ci = ent
            sf, iff = dex.class_fields(ci)
            declared = {n: (t, acc) for (_c, t, n, acc) in iff}
            cd = dex.iter_class_data(ci)
            if cd:
                direct, virtual = cd
                for (midx, acc, coff) in list(direct) + list(virtual):
                    mn = dex.method_ids[midx][1] if midx < len(dex.method_ids) else "?"
                    if mn != "dynamicMethod" or coff == 0:
                        continue
                    code = CodeItem(dex.d, coff, dex)
                    info, objs, _diag = extract_message_info(dex, code.insns)
                    if info is None:
                        continue
                    try:
                        header, fields, _pos, _d2 = decode_field_table(info, objs, declared)
                    except Exception:
                        continue
                    res = (header, fields, dex.class_supers[ci], dex.name)
                    break
        self.cache[cdesc] = res
        return res

    def is_extendable(self, cdesc):
        t = self.table(cdesc)
        return bool(t) and t[2] == "Lgoek;"


def walk(db, extmap, root, max_depth, out, seen, prefix="", depth=0):
    ent = db.table(root)
    sup = ent[2] if ent else "?"
    kind = "ExtendableMessage" if sup == "Lgoek;" else "GeneratedMessageLite"
    out.append(f"{prefix}{root}  [{kind}]{'  (未找到字段表)' if not ent else ''}")
    if not ent:
        return
    header, fields, _sup, _dn = ent
    child_prefix = prefix + "  "
    exts = extmap.get(root, [])
    if exts:
        out.append(f"{child_prefix}-- 扩展 {len(exts)} 个 --")
    for (num, vtype) in sorted(exts):
        vt = vtype if vtype.endswith(";") else vtype + ";"
        t = db.table(vt)
        extra = ""
        if t:
            flds = " ".join(f"#{f['num']}:{f['type_name']}" for f in t[1][:12])
            extra = f"   {{{flds}{' …' if len(t[1]) > 12 else ''}}}"
        out.append(f"{child_prefix}[ext {num}] {vt}{extra}")
        if depth + 1 < max_depth and vt not in seen:
            seen.add(vt)
            walk(db, extmap, vt, max_depth, out, seen, child_prefix + "  ", depth + 1)
    for f in fields:
        tn = f["type_name"]
        base = tn.replace("ONEOF<", "").replace(">", "")
        marker = f"  →{f['ref']}" if f["ref"] else ""
        nm = f["name"] or "?"
        out.append(f"{child_prefix}#{f['num']:<5} {tn:<20} [{nm}]{marker}")
        if base in MSG_TYPES and f["ref"]:
            rt = f["ref"] if f["ref"].endswith(";") else f["ref"] + ";"
            if depth + 1 < max_depth and rt not in seen:
                seen.add(rt)
                walk(db, extmap, rt, max_depth, out, seen, child_prefix + "  ", depth + 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--root", required=True, help="根类描述符正则")
    ap.add_argument("--depth", type=int, default=3)
    ap.add_argument("--extmap", default="out/robin/extension-map.txt")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    extmap = load_extmap(a.extmap)
    db = ProtoDB(a.path)
    rx = re.compile(a.root)
    lines = []
    for c in db.index:
        if not rx.search(c):
            continue
        lines.append("=" * 70)
        walk(db, extmap, c, a.depth, lines, {c})
        lines.append("")
    text = "\n".join(lines)
    if a.out:
        os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        print(f"[+] {len(text.splitlines())} 行 → {a.out}")
    else:
        print(text)


if __name__ == "__main__":
    sys.exit(main())
