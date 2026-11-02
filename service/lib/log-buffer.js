// service/lib/log-buffer.js —— 进程日志环形缓冲（供 /admin 后台展示）
//
// 为什么需要它：服务日志只进 stdout（容器 logs / journald），页面上看不到。
//   本模块把 console 输出**同步抄一份**进内存环形缓冲，/admin 后台可拉最近 N 条。
//
// 设计约束：
//   · 只抄不拦 —— 原 console 行为完全不变（容器日志照常输出，一行不差）；
//   · 环形上限 —— 长跑不无界增长；
//   · 单条截断 —— 超长行（例如内联 base64 附件）不会撑爆缓冲；
//   · 不打日志 —— 本模块自身绝不打日志，否则会递归。

import { format } from "node:util";

const MAX_ENTRIES = 300; // 保留条数
const MAX_LEN = 2000; // 单条最大字符数

/** @type {{seq:number, ts:string, level:string, text:string}[]} */
const buf = [];
let seq = 0;
let installed = false;
let dropped = 0;

function push(level, text) {
  const line = String(text ?? "");
  buf.push({
    seq: ++seq,
    ts: new Date().toISOString(),
    level,
    text: line.length > MAX_LEN ? `${line.slice(0, MAX_LEN)} …(已截断，共 ${line.length} 字符)` : line,
  });
  while (buf.length > MAX_ENTRIES) {
    buf.shift();
    dropped++;
  }
}

/**
 * 安装缓冲：包装 console 的常用方法。
 * 必须尽早调用（server.mjs 顶部），否则之后的日志进不了缓冲。
 */
export function installLogBuffer() {
  if (installed) return;
  installed = true;
  for (const level of ["log", "warn", "error", "info", "debug"]) {
    const orig = console[level];
    if (typeof orig !== "function") continue;
    const bound = orig.bind(console);
    console[level] = (...args) => {
      try {
        push(level, format(...args));
      } catch {
        /* 格式化失败就放弃抄录，不影响原输出 */
      }
      bound(...args);
    };
  }
}

/** 最近的日志（新的在后） */
export function logSnapshot(limit = 200) {
  const n = Math.max(1, Math.min(MAX_ENTRIES, Number(limit) || 200));
  return buf.slice(-n);
}

/** 缓冲自身状态（供 /admin 的「日志」卡片显示容量） */
export function logBufferStatus() {
  return {
    enabled: installed,
    kept: buf.length,
    max: MAX_ENTRIES,
    dropped,
    total: seq,
    maxLen: MAX_LEN,
  };
}
