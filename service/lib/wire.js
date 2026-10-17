// lib/wire.js — 零依赖 protobuf wire 编解码 + gRPC 帧封包
//
// 为什么手写而不是用 protobufjs：
//   1) Vercel serverless：零 npm 依赖 → 包体几 KB、冷启动最快；
//   2) Robin 的扩展字段（ext 1000/1001/…）在 wire 上与普通字段完全一致（tag 直接用扩展号），
//      不需要 .proto 描述文件，直接按逆向出的字段表（docs/stage2-robin-protocol.md）构造；
//   3) 只需 encode 自己构造的请求 + 按需 decode 响应，用不到反射/descriptor/JSON 映射。

export const WT = { VARINT: 0, I64: 1, LEN: 2, I32: 5 };

const ENC = new TextEncoder();
const DEC = new TextDecoder("utf-8", { fatal: false });

/* ---------------- 标量编解码 ---------------- */

export function writeVarint(value) {
  let v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n) v += 1n << 64n; // int32/int64 负数 → 64 位二补码（固定 10 字节）
  const out = [];
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
}

export function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  while (p < buf.length) {
    const b = buf[p++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, p];
    shift += 7n;
    if (shift > 63n) throw new Error("varint 超长（>10 字节）");
  }
  throw new Error("varint 截断（buffer 提前结束）");
}

export function zigzagEncode(value) {
  const v = BigInt(value);
  return v >= 0n ? v << 1n : ((-v) << 1n) - 1n;
}

export function zigzagDecode(v) {
  return (v & 1n) ? -((v + 1n) >> 1n) : v >> 1n;
}

/* ---------------- 写入（构造请求） ---------------- */

export class Writer {
  constructor() {
    this.parts = [];
  }

  tag(field, wt) {
    this.parts.push(writeVarint((BigInt(field) << 3n) | BigInt(wt)));
    return this;
  }

  varint(field, value) {
    this.tag(field, WT.VARINT);
    this.parts.push(writeVarint(value));
    return this;
  }

  bool(field, v) {
    return this.varint(field, v ? 1 : 0);
  }

  /** sint32 / sint64（zigzag） */
  sint(field, value) {
    this.tag(field, WT.VARINT);
    this.parts.push(writeVarint(zigzagEncode(value)));
    return this;
  }

  bytes(field, buf) {
    const b = buf instanceof Uint8Array ? buf : Uint8Array.from(buf);
    this.tag(field, WT.LEN);
    this.parts.push(writeVarint(b.length), b);
    return this;
  }

  string(field, s) {
    return this.bytes(field, ENC.encode(s));
  }

  /** 嵌套消息：sub 可为 Writer（自动 finish）或已编码字节 */
  message(field, sub) {
    return this.bytes(field, sub instanceof Writer ? sub.finish() : sub);
  }

  /** repeated（packed）varint，如 Lgavd 的 int 列表 */
  packedVarint(field, values) {
    if (!values || values.length === 0) return this; // proto3 空 packed 不落盘
    const inner = new Writer();
    for (const v of values) inner.parts.push(writeVarint(v));
    return this.bytes(field, inner.finish());
  }

  fixed32(field, value) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value >>> 0, true);
    this.tag(field, WT.I32);
    this.parts.push(b);
    return this;
  }

  finish() {
    let n = 0;
    for (const p of this.parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    this.parts = [out]; // 幂等：重复 finish 不会重复追加
    return out;
  }
}

/* ---------------- 读取（解析响应） ---------------- */

/** 解析一层字段 → [{no, wt, value}]。value：VARINT→BigInt；LEN→Uint8Array；I64/I32→Uint8Array */
export function decodeFields(buf) {
  const out = [];
  let p = 0;
  while (p < buf.length) {
    let head;
    [head, p] = readVarint(buf, p);
    const no = Number(head >> 3n);
    const wt = Number(head & 7n);
    if (wt === WT.VARINT) {
      let v;
      [v, p] = readVarint(buf, p);
      out.push({ no, wt, value: v });
    } else if (wt === WT.LEN) {
      let len;
      [len, p] = readVarint(buf, p);
      const n = Number(len);
      out.push({ no, wt, value: buf.subarray(p, p + n) });
      p += n;
    } else if (wt === WT.I64) {
      out.push({ no, wt, value: buf.subarray(p, p + 8) });
      p += 8;
    } else if (wt === WT.I32) {
      out.push({ no, wt, value: buf.subarray(p, p + 4) });
      p += 4;
    } else {
      throw new Error(`无法解析 wire type ${wt}（字段 ${no}）`);
    }
  }
  return out;
}

export function fieldAll(buf, no) {
  return decodeFields(buf).filter((f) => f.no === no);
}

export function fieldOne(buf, no) {
  return decodeFields(buf).find((f) => f.no === no);
}

export function asString(data) {
  return DEC.decode(data);
}

export function asUint(v) {
  return v <= 9007199254740991n ? Number(v) : v;
}

export function asInt32(v) {
  return Number(BigInt.asIntN(32, v));
}

export function asInt64(v) {
  return Number(BigInt.asIntN(64, v));
}

/** 解 packed varint 字节流（无 tag，纯连续 varint） */
export function decodePackedVarint(buf) {
  const out = [];
  let p = 0;
  while (p < buf.length) {
    const [v, np] = readVarint(buf, p);
    out.push(v);
    p = np;
  }
  return out;
}

/* ---------------- gRPC 帧：1 字节压缩标志 + 4 字节大端长度 + payload ---------------- */

export function grpcFrame(payload) {
  const b = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  const out = new Uint8Array(5 + b.length);
  out[0] = 0; // 未压缩
  new DataView(out.buffer).setUint32(1, b.length, false);
  out.set(b, 5);
  return out;
}

/** 增量拆帧器：HTTP/2 DATA chunk 边界与 gRPC 帧边界无关，必须缓冲重组 */
export class GrpcFrameDecoder {
  constructor() {
    this.buf = new Uint8Array(0);
  }

  /** 喂入任意 chunk → 返回本次可解析出的完整帧 [{compressed, payload}] */
  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const buf = merged;
    let p = 0;
    const frames = [];
    while (buf.length - p >= 5) {
      const len = new DataView(buf.buffer, buf.byteOffset + p + 1, 4).getUint32(0, false);
      if (buf.length - p - 5 < len) break;
      frames.push({ compressed: buf[p] === 1, payload: buf.slice(p + 5, p + 5 + len) });
      p += 5 + len;
    }
    this.buf = buf.slice(p);
    return frames;
  }
}
