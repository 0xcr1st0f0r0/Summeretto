// service/lib/toolcall.js — function calling 兼容层（prompt 仿真）
//
// ★ 背景（2026-10-15 实证）：Robin 私有协议【没有工具声明通道】——
//   tools 字段若直接丢弃，模型会凭自身知识幻觉作答（实测问"北京天气"→
//   编造 15°C 多云，functionCall=0，且无任何报错）。静默错误答案比
//   响亮失败危险得多，故实现 prompt 仿真兼容层。
//
// ★ 方案来源：gemini_web2api（D:\work\gemini-web2api，OpenAI 格式反代，
//   已被大量用户验证）。核心思路：
//     请求侧：把工具声明序列化进 prompt（约定 ```function_call 围栏格式），
//             历史里的 functionCall / functionResponse part 也转成文本标记；
//     响应侧：从模型输出里解析围栏块，回填为 Gemini 原生 functionCall parts。
//   底层模型是同一个 Gemini，工具能力在模型侧，只是私有协议不暴露声明位——
//   所以"约定格式 + 提示词引导"可以让模型自己产出结构化调用。
//
// 与本项目的关系：本代理说 Gemini 原生格式（contents/systemInstruction/tools/
//   toolConfig），与 gemini_web2api 的 Google API 路径同构，方案可直接移植。

/** 请求体是否携带工具/函数声明（google-genai SDK: tools=[{functionDeclarations:[…]}]） */
export function hasToolDeclarations(body) {
  return Array.isArray(body?.tools) && body.tools.length > 0;
}

/**
 * 从 Gemini 请求体提取工具定义 → [{name, description, parameters}]
 * 兼容 functionDeclarations 与 parametersJsonSchema 两种参数 schema 形态。
 */
export function extractToolDefs(body) {
  const out = [];
  for (const group of body?.tools ?? []) {
    for (const fn of group?.functionDeclarations ?? []) {
      if (!fn?.name) continue;
      const td = { name: fn.name, description: fn.description ?? "" };
      const params = fn.parameters ?? fn.parametersJsonSchema;
      if (params) td.parameters = params;
      out.push(td);
    }
  }
  return out;
}

/** toolConfig.functionCallingConfig 的约束指令（mode: AUTO 默认 / ANY / NONE） */
export function toolChoiceConstraint(body, toolDefs) {
  // ⚠️ 别名兼容：不同 SDK 版本对嵌套结构的序列化大小写不一致（见 gemini.js 的 alias()）。
  //   工具配置若解析不到会被静默忽略 ⇒ 模型不受约束，属危险失败。
  const tc = body?.toolConfig ?? body?.tool_config ?? {};
  const fc = tc?.functionCallingConfig ?? tc?.function_calling_config ?? {};
  const mode = fc?.mode ?? "AUTO";
  const allowed = Array.isArray(fc?.allowedFunctionNames)
    ? fc.allowedFunctionNames
    : Array.isArray(fc?.allowed_function_names)
      ? fc.allowed_function_names
      : [];
  if (mode === "NONE") {
    return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
  }
  if (mode === "ANY") {
    if (allowed.length) {
      const names = allowed.map((n) => `"${n}"`).join(", ");
      return `\n\nIMPORTANT: You MUST call one of these tools: ${names}. Do not respond with text only.`;
    }
    return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
  }
  // AUTO：allowedFunctionNames 在 AUTO 下是白名单提示（软约束）
  if (allowed.length) {
    const names = allowed.map((n) => `"${n}"`).join(", ");
    return `\n\nOnly call tools from this list: ${names}.`;
  }
  return "";
}

/**
 * 构造工具使用提示词块（紧贴 gemini_web2api 的 build_tool_prompt，
 * 其措辞经过真实通道验证，可降低模型不遵循格式的概率）。
 */
export function buildToolPrompt(toolDefs, body) {
  const spec = JSON.stringify(toolDefs, null, 2);
  return (
    "# Tool Use\n\n" +
    "You can call the following tools to help accomplish tasks. " +
    "These tools connect to the user's local environment and will execute when called.\n\n" +
    "Call format (use this exact format):\n" +
    "```function_call\n" +
    '{"name": "<tool_name>", "args": {<arguments>}}\n' +
    "```\n\n" +
    "When calling tools:\n" +
    "- Output ONLY the function_call block(s), nothing else\n" +
    "- You may call multiple tools with multiple blocks\n" +
    "- After receiving a [Tool result for ...], use that data to answer the user\n\n" +
    `Available tools:\n${spec}`
  );
}

/** 历史里的 functionCall part → 文本标记（与提示词约定的格式一致，模型能认出来） */
export function formatFunctionCallHistory(fc) {
  return `\`\`\`function_call\n${JSON.stringify({ name: fc?.name, args: fc?.args ?? {} })}\n\`\`\``;
}

/** 历史里的 functionResponse part → 文本标记 */
export function formatFunctionResponseHistory(fr) {
  const resp = fr?.response ?? {};
  const body = typeof resp === "string" ? resp : JSON.stringify(resp);
  return `[Tool result for ${fr?.name ?? ""}]: ${body}`;
}

/** 参数归一化：非对象参数包成 {value: …}，保证 args 恒为对象（Gemini functionCall 契约） */
function normalizeArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return {};
    try {
      const parsed = JSON.parse(s);
      return typeof parsed === "object" && parsed !== null ? parsed : { value: parsed };
    } catch {
      return { value: raw };
    }
  }
  if (typeof raw === "object") return raw;
  return { value: raw };
}

/**
 * 从 s[start]（必须是 '{'）按括号深度扫出完整 JSON 文本 → [json, endIndex]。
 * 深度计数跳过字符串字面量内部的括号（JSON 里 "}" 可能是参数值）。
 * 惰性正则（\{…?\}）会在嵌套对象上过早截断，故必须手工扫描。
 */
function extractBalancedJson(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return [s.slice(start, i + 1), i + 1];
    }
  }
  return [null, start];
}

/**
 * 从模型输出解析 function_call 块 → { cleanText, calls: [{name, args}] }
 *
 * 支持三种形态（按优先级）：
 *   1. ```function_call\n{…}\n```   —— 提示词约定的标准围栏
 *   2. (行首)function_call\n{…}     —— 模型偶发漏掉围栏
 *   3. 整段输出就是 {name, args} JSON —— 兜底
 * allowedNames 非空时只接受名单内的工具（防模型幻觉出不存在的工具名）。
 */
export function parseFunctionCalls(text, allowedNames = null) {
  const src = String(text ?? "");
  const calls = [];
  const allowed = allowedNames?.length ? new Set(allowedNames) : null;

  const accept = (data) => {
    if (!data || typeof data !== "object") return false;
    if (typeof data.name !== "string" || !data.name) return false;
    if (allowed && !allowed.has(data.name)) return false;
    calls.push({ name: data.name, args: normalizeArgs(data.args ?? data.arguments) });
    return true;
  };

  const tryJson = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  // 1. 标准围栏
  let clean = src;
  const fenced = /```function_call\s*\n([\s\S]*?)\n```/g;
  let m;
  const fencedSpans = [];
  while ((m = fenced.exec(src)) !== null) {
    const data = tryJson(m[1].trim());
    if (data && accept(data)) fencedSpans.push(m);
  }
  if (calls.length) {
    // 从后往前删，避免 span 偏移
    for (let i = fencedSpans.length - 1; i >= 0; i--) {
      clean = clean.slice(0, fencedSpans[i].index) + clean.slice(fencedSpans[i].index + fencedSpans[i][0].length);
    }
    return { cleanText: clean.trim(), calls };
  }

  // 2. 无围栏：行首 function_call + 平衡括号 JSON（支持嵌套参数对象）
  const bareMarker = /(?:^|\n)function_call\s*\n/g;
  const bareSpans = [];
  let m2;
  while ((m2 = bareMarker.exec(clean)) !== null) {
    let j = m2.index + m2[0].length;
    while (j < clean.length && /\s/.test(clean[j])) j++;
    if (clean[j] !== "{") continue;
    const [json, end] = extractBalancedJson(clean, j);
    if (!json) continue;
    const data = tryJson(json);
    if (data && accept(data)) bareSpans.push([m2.index, end]);
  }
  if (calls.length) {
    for (let i = bareSpans.length - 1; i >= 0; i--) {
      clean = clean.slice(0, bareSpans[i][0]) + clean.slice(bareSpans[i][1]);
    }
    return { cleanText: clean.trim(), calls };
  }

  // 3. 整段 raw JSON 兜底
  const stripped = clean.trim();
  if (stripped.startsWith("{") && stripped.endsWith("}")) {
    const data = tryJson(stripped);
    if (data && accept(data)) return { cleanText: "", calls };
  }

  return { cleanText: src.trim(), calls: [] };
}

/**
 * 把 Gemini contents[] 里的 functionCall / functionResponse part 转成文本标记。
 * 由 gemini.js 的 pushPart 调用；返回 null 表示该 part 不是工具相关。
 */
export function toolPartToText(p) {
  // ⚠️ SDK 版本差异：2.28.0 在部分嵌套结构上会输出 snake_case（见 gemini.js 的
  //   alias() 说明），故这里 camelCase / snake_case 两种键名都认。
  const fc = p?.functionCall ?? p?.function_call;
  if (fc) return formatFunctionCallHistory(fc);
  const fr = p?.functionResponse ?? p?.function_response;
  if (fr) return formatFunctionResponseHistory(fr);
  return null;
}
