#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apksig.py —— 零依赖提取 APK 签名证书指纹

用途：
  从 APK 的 v2/v3 签名块提取签名证书，计算 SHA-1 / SHA-256 指纹
  （十六进制小写，无冒号）—— 即 Google Play 老协议中的 client_sig。

背景（见 docs/credential-acquisition.md）：
  android.clients.google.com/auth 的 perform_oauth 请求需要
  app=包名 + client_sig=签名证书指纹，服务端据此判断调用者身份。

用法：
  python tools/apksig.py <apk 路径> [--json]
"""
import hashlib
import struct
import sys


def _read_len_prefixed(data: bytes, p: int):
    """返回 (payload, 新位置)；payload 前置 uint32 LE 长度"""
    n = struct.unpack_from("<I", data, p)[0]
    return data[p + 4 : p + 4 + n], p + 4 + n


def parse_signing_block(path: str):
    """解析 APK Signing Block，返回 {pair_id: value_bytes}"""
    with open(path, "rb") as f:
        data = f.read()

    eocd = data.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise ValueError("不是有效 ZIP/APK（找不到 EOCD）")
    cd_offset = struct.unpack_from("<I", data, eocd + 16)[0]

    magic_off = cd_offset - 16
    if data[magic_off : magic_off + 16] != b"APK Sig Block 42":
        raise ValueError("无 APK Signing Block（可能只有 v1 签名，或未签名）")

    block_size = struct.unpack_from("<Q", data, magic_off - 8)[0]
    block_start = cd_offset - block_size - 8

    # 块布局（官方 apksig 规范）：
    #   [block_size:uint64] [ {pair_len:uint64}{pair_id:uint32}{pair_value} ... ]
    #   [block_size:uint64] [magic "APK Sig Block 42":16]
    #   注意：pair_len 是 uint64，且 **包含 4 字节的 pair_id**。
    pairs = {}
    p = block_start + 8  # 跳过首个 block_size
    while p + 8 <= magic_off - 8:
        pair_len = struct.unpack_from("<Q", data, p)[0]
        if pair_len < 4:
            break
        pair_id = struct.unpack_from("<I", data, p + 8)[0]
        pairs[pair_id] = data[p + 12 : p + 8 + pair_len]
        p += 8 + pair_len
    return pairs


def certs_from_v2(value: bytes):
    """从 v2（0x7109871a）签名块 value 中提取证书 DER 列表"""
    certs = []
    # signers: uint32 size + signer[]
    signers, _ = _read_len_prefixed(value, 0)
    p = 0
    while p < len(signers):
        signer, p = _read_len_prefixed(signers, p)
        # signer = signed_data + signatures + public_key
        signed_data, sp = _read_len_prefixed(signer, 0)
        # signed_data = digests + certificates + attrs
        _digests, dp = _read_len_prefixed(signed_data, 0)
        cert_seq, _ = _read_len_prefixed(signed_data, dp)
        cp = 0
        while cp < len(cert_seq):
            cert, cp = _read_len_prefixed(cert_seq, cp)
            certs.append(cert)
    return certs


def certs_from_v3(value: bytes):
    """从 v3（0xf05368c0）签名块 value 中提取证书 DER 列表"""
    certs = []
    signers, _ = _read_len_prefixed(value, 0)
    p = 0
    while p < len(signers):
        signer, p = _read_len_prefixed(signers, p)
        # signer = signed_data(lp) + min_sdk(uint32) + max_sdk(uint32)
        #          + signatures(lp) + public_key(lp)
        # 只需 signed_data 即可拿到证书链
        signed_data, _sp = _read_len_prefixed(signer, 0)
        # signed_data 内部：digests(lp) + certificates(lp) + min_sdk + max_sdk + attrs(lp)
        _digests, dp = _read_len_prefixed(signed_data, 0)
        cert_seq, dp = _read_len_prefixed(signed_data, dp)
        cp = 0
        while cp < len(cert_seq):
            cert, cp = _read_len_prefixed(cert_seq, cp)
            certs.append(cert)
    return certs


def fingerprints(path: str):
    pairs = parse_signing_block(path)
    V2, V3 = 0x7109871A, 0xF05368C0
    certs = []
    scheme = None
    if V2 in pairs:
        certs = certs_from_v2(pairs[V2])
        scheme = "v2"
    if not certs and V3 in pairs:
        certs = certs_from_v3(pairs[V3])
        scheme = "v3"

    out = {"scheme": scheme, "signing_block_ids": [hex(k) for k in pairs], "certs": []}
    for der in certs:
        out["certs"].append(
            {
                "sha1": hashlib.sha1(der).hexdigest(),
                "sha256": hashlib.sha256(der).hexdigest(),
                "der_len": len(der),
            }
        )
    return out


def main():
    import json

    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    path = sys.argv[1]
    info = fingerprints(path)
    if "--json" in sys.argv:
        print(json.dumps(info, indent=2))
        return
    print(f"文件: {path}")
    print(f"签名方案: {info['scheme']}   签名块 ID: {', '.join(info['signing_block_ids'])}")
    for i, c in enumerate(info["certs"]):
        print(f"  证书[{i}]  SHA-1   = {c['sha1']}   （client_sig 候选）")
        print(f"           SHA-256 = {c['sha256']}")
        print(f"           DER 长度 = {c['der_len']}")


if __name__ == "__main__":
    main()
