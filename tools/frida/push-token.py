#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
push-token.py —— 把设备上提取的 Robin token 推送到反代服务

配合 tools/frida/extract-robin-token.js 使用：
    1. 手机（root）上跑 frida-server，注入提取脚本（token 落到 /data/local/tmp/robin-token.json）
    2. PC 上跑本脚本，轮询设备上的 token 文件并 POST 到服务端 /admin/token

用法：
    # 单次推送
    python tools/frida/push-token.py --server https://xxx.vercel.app --admin-key <KEY>

    # 持续保鲜（每 5 分钟检查一次；token 变化才推送）
    python tools/frida/push-token.py --server https://xxx.vercel.app --admin-key <KEY> --watch

依赖：adb 在 PATH 中；手机已 root（su 可用）
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.request

DEVICE_FILE = "/data/local/tmp/robin-token.json"


def adb_read_token(serial=None):
    """从设备读取最近一条 token 记录。返回 (token, account) 或 None。"""
    cmd = ["adb"]
    if serial:
        cmd += ["-s", serial]
    cmd += ["shell", "su", "-c", f"cat {DEVICE_FILE}"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except FileNotFoundError:
        print("[!] 找不到 adb，请确认已安装 Android platform-tools 且加入 PATH")
        return None
    if out.returncode != 0 or not out.stdout.strip():
        return None
    try:
        arr = json.loads(out.stdout)
    except json.JSONDecodeError:
        return None
    if not isinstance(arr, list) or not arr:
        return None
    last = arr[-1]
    tok = last.get("token", "")
    if not tok.startswith("ya29."):
        return None
    return tok, last.get("account")


def push(server, admin_key, token, account=None, expires_in=3600):
    url = server.rstrip("/") + "/admin/token"
    body = json.dumps(
        {"token": token, "expiresIn": expires_in, "account": account}
    ).encode()
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"content-type": "application/json", "x-admin-key": admin_key},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status, r.read().decode()


def main():
    ap = argparse.ArgumentParser(description="Robin token 推送器")
    ap.add_argument("--server", required=True, help="反代服务地址，如 https://xxx.vercel.app")
    ap.add_argument("--admin-key", required=True, help="服务端 ADMIN_KEY")
    ap.add_argument("--serial", default=None, help="adb 设备序列号（多设备时指定）")
    ap.add_argument("--watch", action="store_true", help="持续模式")
    ap.add_argument("--interval", type=int, default=300, help="持续模式轮询间隔（秒，默认 300）")
    args = ap.parse_args()

    last_pushed = None
    while True:
        got = adb_read_token(args.serial)
        if not got:
            print("[·] 设备上暂无 token（先跑 Frida 提取脚本并触发一次 Gemini 对话）")
        else:
            tok, acct = got
            if tok != last_pushed:
                try:
                    code, text = push(args.server, args.admin_key, tok, acct)
                    print(f"[✓] 已推送 token（…{tok[-8:]}）→ HTTP {code}")
                    print(f"    {text}")
                    last_pushed = tok
                except Exception as e:
                    print(f"[!] 推送失败: {e}")
            else:
                print("[·] token 未变化，跳过")

        if not args.watch:
            break
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
