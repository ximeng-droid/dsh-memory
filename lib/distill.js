/**
 * 4E-2 蒸馏管线：把一次会话的流水交给模型，压成「条目 + 场景」。
 *
 * 设计约束（见策划书 §24.2 / §24.12）：
 * - 直接调 `ctx.llm.stream()` 是**单次尝试**，不受 agent 重试保护 ⇒ 自己退避重试
 * - 每次都是一次真实计费请求 ⇒ 只在「会话落盘后（队列）」与「手动 /memory 蒸馏」跑
 * - 任何失败都只记诊断，绝不阻塞主流程
 */

export const PROMPT_VERSION = 1;
export const MAX_ENTRIES = 6;
export const MAX_SCENES = 2;
export const MAX_SKILLS = 2;
export const MAX_TURN_ENTRIES = 3;

const TYPES = new Set([
  'preference', 'forbidden', 'decision', 'experience',
  'fact', 'project', 'knowledge', 'profile',
]);

/** 把会话记录拼成给模型看的流水（你 / 我），超长从头截断（保留最近的） */
export function buildTranscript(records, { maxChars = 24000 } = {}) {
  const lines = [];
  for (const r of records || []) {
    const who = r.role === 'user' ? '你' : '我';
    const text = String(r.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push(`${who}：${text}`);
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  return out;
}

export function buildMessages(records, { maxChars = 60000 } = {}) {
  const transcript = buildTranscript(records, { maxChars });
  const system = [
    '你是一个编程会话的记忆整理器。',
    '输入是「你」（用户）与「我」（助手）的对话流水。请只抽取下次还用得上的东西，输出严格 JSON。',
    '',
    '输出格式：',
    '{',
    '  "entries": [{"type": "preference|forbidden|decision|experience|fact|project|knowledge",',
    '               "title": "不超过 40 字", "body": "不超过 300 字", "why": "为什么值得记"}],',
    '  "scenes":  [{"title": "这次干了什么", "goal": "目标", "steps": ["步骤"],',
    '               "result": "结果", "pitfalls": ["踩的坑"], "turns": [起, 止]}],',
    '  "skills":  [{"title": "可复用的做法", "when": "什么时候用", "how": ["步骤"],',
    '               "pitfalls": ["坑"], "verify": "怎么验证", "keywords": ["关键词"],',
    '               "scope": "project|global"}]',
    '}',
    '',
    '规则：',
    '1. 只记「下次还用得上」的；寒暄、客套、一次性的调试试探都不要。',
    '2. 事实必须带具体值（路径、版本号、端口、命令名）；没有具体值就别当事实记。',
    `3. entries 最多 ${MAX_ENTRIES} 条，scenes 最多 ${MAX_SCENES} 个，skills 最多 ${MAX_SKILLS} 个；宁可少不要凑。`,
    '4. 用户明确表达的偏好/禁忌（「以后都…」「别再…」）优先，type 用 preference 或 forbidden。',
    '5. 已经有了的常识不要记（例如「代码要能跑」）。',
    '6. skills 只放「换一个项目也能照做」的操作方法（步骤、坑、验证）；只对当前仓库有意义的不要放。',
    '   scope 默认 project —— 只有明确是通用方法（跟具体项目无关）才写 global。',
    '7. 只输出 JSON，不要解释、不要 markdown 代码块。',
  ].join('\n');

  return [
    { role: 'system', content: [{ type: 'text', text: system }] },
    { role: 'user', content: [{ type: 'text', text: `会话流水：\n\n${transcript}` }] },
  ];
}

/** 从模型输出里抠出 JSON（容忍 ```json 围栏与前后废话） */
/** 从一段文本里找出所有「括号配平」的候选 JSON（不处理注释，字符串/转义会跳过） */
function jsonCandidates(text) {
  const src = String(text || '');
  const out = [];
  let depth = 0;
  let startPos = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') {
      if (depth === 0) startPos = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && startPos >= 0) {
        out.push(src.slice(startPos, i + 1));
        startPos = -1;
      }
    }
  }
  return out;
}

/**
 * 从模型输出里取结构化结果。
 * 模型经常把 JSON 连写两遍、或在前后带说明文字，所以逐个候选试解析，
 * 取第一个含 entries/scenes 的；都没有就丢出最后一次的解析错误。
 */
function lastJsonObject(text) {
  const src = String(text || '');
  const end = src.lastIndexOf('}');
  if (end < 0) return null;
  const tail = src.slice(0, end + 1);
  let tries = 0;
  for (let i = tail.length - 1; i >= 0 && tries < 300; i -= 1) {
    if (tail[i] !== '{') continue;
    tries += 1;
    try {
      const obj = JSON.parse(tail.slice(i));
      if (obj && typeof obj === 'object') return obj;
    } catch { /* 继续往前找 */ }
  }
  return null;
}

export function parseDistill(text) {
  const src = String(text || '');
  if (!src.trim()) throw new Error('没有输出');
  const cands = jsonCandidates(src);
  if (!cands.length) {
    const only = lastJsonObject(src);
    if (only) return only;
    throw new Error('输出里没有 JSON 对象');
  }
  let lastErr = null;
  let fallback = null;
  for (const c of cands) {
    let obj;
    try {
      obj = JSON.parse(c);
    } catch (err) {
      lastErr = err;
      continue;
    }
    if (obj && typeof obj === 'object' && ('entries' in obj || 'scenes' in obj)) return obj;
    if (!fallback && obj && typeof obj === 'object') fallback = obj;
  }
  if (fallback) return fallback;
  const last = lastJsonObject(src);
  if (last && ('entries' in last || 'scenes' in last || 'skills' in last)) return last;
  if (lastErr) throw new Error('JSON 解析失败：' + lastErr.message);
  throw new Error('输出里没有 JSON 对象');
}

/** 取字符串并截断 */
function str(v, max) {
  const s = typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v);
  if (!s) return '';
  const n = Math.max(1, Number(max) || 0);
  return s.length > n ? s.slice(0, n) : s;
}

/* ------------------------------------------------------------------
   单轮模式（§25）：只从「这一问一答」里抽条目，不抽场景/技能。
   关键判据：助手复述用户给的规则也算。
   本轮只看文本：不读图片、不做多模态、不做向量召回增强（这三样以后再说）。
   ------------------------------------------------------------------ */
export function buildTurnMessages(turn = {}, { maxChars = 12000 } = {}) {
  const user = String(turn.user || '').slice(0, maxChars)
  const assistant = String(turn.assistant || '').slice(0, maxChars)
  const system = [
    '你是编程对话的记忆整理器。输入是刚才的一问一答。',
    '任务：判断这一轮里，用户有没有定下一条"下次还该遵守"的规则、约定、偏好或决定。只输出严格 JSON。',
    '',
    '输出格式：',
    '{"entries":[{"type":"preference|forbidden|decision|experience|fact|project|knowledge",',
    '             "title":"不超过 40 字","body":"不超过 300 字","why":"凭什么认为这是用户定的",',
    '             "confidence":"high|low"}]}',
    '',
    '判据：',
    '1. 助手把用户给的规则/标准/流程写成文字时，按助手复述的内容记一条，why 写「助手复述用户规则」。',
    '2. 只记可复用的；一次性的任务状态（"今天做完了 X"）、过程叙述（"我先改 A 再改 B"）不记。',
    '3. 宁少勿滥：拿不准就不输出；输出 {"entries":[]} 是合法结果。',
    '4. type 只准用上面七类；用户说"别用/不要"用 forbidden，说"以后都"用 preference，做过的取舍用 decision。',
    '5. 事实必须带具体值（路径、端口、版本、命令）；没有具体值别当事实记。',
    '6. 只依据文本：用户只发了图片、附件或链接而没有文字规则时，不要凭猜测补条目。',
    '7. 只输出 JSON，不要解释、不要 markdown 代码块。',
  ].join('\n')
  return [
    { role: 'system', content: [{ type: 'text', text: system }] },
    { role: 'user', content: [{ type: 'text', text: `用户说：${user}\n\n助手回：${assistant}` }] },
  ]
}

export function validateTurn(obj, { maxEntries = MAX_TURN_ENTRIES } = {}) {
  const out = { entries: [], scenes: [], skills: [], dropped: [] }
  if (!obj || typeof obj !== 'object') throw new Error('不是对象')
  const incoming = Array.isArray(obj.entries) ? obj.entries.length : 0
  for (const item of Array.isArray(obj.entries) ? obj.entries : []) {
    const type = TYPES.has(String(item?.type || '')) ? String(item.type) : ''
    const title = str(item?.title, 40)
    const body = str(item?.body, 300)
    if (!type || title.length < 2 || body.length < 2) {
      out.dropped.push({ kind: 'entry', reason: '字段不全', raw: title })
      continue
    }
    if (out.entries.length >= maxEntries) { out.dropped.push({ kind: 'entry', reason: '超过上限', raw: title }); continue }
    out.entries.push({
      type, title, body,
      why: str(item?.why, 120) || '单轮抽取',
      confidence: String(item?.confidence || '').toLowerCase() === 'high' ? 'high' : 'low',
    })
  }
  if (!out.entries.length && !out.dropped.length && incoming > 0) throw new Error('没有输出');
  if (!out.entries.length && incoming > 0) throw new Error('模型没给出可用的条目或场景');
  return out;
}

export function validateDistill(obj, { maxEntries = MAX_ENTRIES, maxScenes = MAX_SCENES, maxSkills = MAX_SKILLS } = {}) {
  const out = { entries: [], scenes: [], skills: [], dropped: [] };
  if (!obj || typeof obj !== 'object') throw new Error('不是对象');

  for (const item of Array.isArray(obj.entries) ? obj.entries : []) {
    const type = TYPES.has(String(item?.type || '')) ? String(item.type) : '';
    const title = str(item?.title, 40);
    const body = str(item?.body, 300);
    if (!type || title.length < 2 || body.length < 2) {
      out.dropped.push({ kind: 'entry', reason: '字段不全', raw: str(item?.title, 40) });
      continue;
    }
    if (out.entries.length >= maxEntries) { out.dropped.push({ kind: 'entry', reason: '超过上限', raw: title }); continue; }
    out.entries.push({ type, title, body, why: str(item?.why, 120) });
  }

  for (const item of Array.isArray(obj.scenes) ? obj.scenes : []) {
    const title = str(item?.title, 60);
    if (title.length < 2) { out.dropped.push({ kind: 'scene', reason: '没标题' }); continue; }
    if (out.scenes.length >= maxScenes) { out.dropped.push({ kind: 'scene', reason: '超过上限', raw: title }); continue; }
    out.scenes.push({
      title,
      goal: str(item?.goal, 300),
      steps: (Array.isArray(item?.steps) ? item.steps : []).map((s) => str(s, 200)).filter(Boolean).slice(0, 12),
      result: str(item?.result, 300),
      pitfalls: (Array.isArray(item?.pitfalls) ? item.pitfalls : []).map((s) => str(s, 200)).filter(Boolean).slice(0, 8),
      turns: Array.isArray(item?.turns) && item.turns.length === 2
        ? [Number(item.turns[0]) || 0, Number(item.turns[1]) || 0]
        : [0, 0],
    });
  }

  for (const item of Array.isArray(obj.skills) ? obj.skills : []) {
    const title = str(item?.title, 48);
    const when = str(item?.when, 400);
    if (title.length < 2 || when.length < 2) { out.dropped.push({ kind: 'skill', reason: '字段不全', raw: title }); continue; }
    if (out.skills.length >= maxSkills) { out.dropped.push({ kind: 'skill', reason: '超过上限', raw: title }); continue; }
    out.skills.push({
      title,
      when,
      how: (Array.isArray(item?.how) ? item.how : []).map((s) => str(s, 240)).filter(Boolean).slice(0, 12),
      pitfalls: (Array.isArray(item?.pitfalls) ? item.pitfalls : []).map((s) => str(s, 240)).filter(Boolean).slice(0, 8),
      verify: str(item?.verify, 300),
      keywords: (Array.isArray(item?.keywords) ? item.keywords : []).map((s) => str(s, 24)).filter(Boolean).slice(0, 6),
      scope: String(item?.scope || '').toLowerCase() === 'global' ? 'global' : 'project',
    });
  }

  if (!out.entries.length && !out.scenes.length && !out.skills.length) {
    throw new Error('模型没给出可用的条目或场景');
  }
  return out;
}

/** 把 stream 的 chunk 拼成文本：兼容各种 delta 形状 */
/** 只收正文增量：reasoning-delta / tool-call-delta 一律丢弃（思考过程会把 JSON 解析带偏） */
export function collectChunk(buf, chunk) {
  if (chunk == null) return buf;
  if (typeof chunk === 'string') return buf + chunk;
  const type = String(chunk.type || '');
  if (type === 'reasoning-delta' || type === 'tool-call-delta') return buf;
  if (type === 'finish' || type === 'usage' || type === 'error') return buf;
  const add = (v) => { if (typeof v === 'string' && v) buf += v; };
  add(chunk.text);
  add(chunk.delta?.text);
  add(chunk.content?.text);
  add(chunk.block?.text);
  if (Array.isArray(chunk.content)) {
    for (const p of chunk.content) {
      if (p?.type === 'reasoning' || p?.type === 'tool-call') continue;
      if (typeof p?.text === 'string') buf += p.text;
    }
  }
  return buf;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const BACKOFF = [2000, 8000, 30000];

/**
 * 调模型拿蒸馏结果。
 * @param call  (messages) => AsyncIterable  由 index.js 包一层 ctx.llm.stream
 */
export async function distillOnce({ call, records, turn, cfg = {}, log = () => {}, mode = 'session' }) {
  const isTurn = mode === 'turn';
  const messages = isTurn
    ? buildTurnMessages(turn || {}, { maxChars: cfg.maxInputChars || 12000 })
    : buildMessages(records, { maxChars: cfg.maxInputChars || 24000 });
  let parseFails = 0;
  const retries = Math.max(0, Math.min(5, Number(cfg.retries ?? 3)));
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const ladder = Array.isArray(cfg.backoff) && cfg.backoff.length ? cfg.backoff : BACKOFF;
      const wait = ladder[Math.min(attempt - 1, ladder.length - 1)];
      log(`蒸馏第 ${attempt} 次重试（等 ${wait}ms）`);
      await sleep(wait);
    }
    try {
      const timeoutMs = Math.max(5000, Number(cfg.timeoutMs ?? 45000));
      let timer = null;
      const consume = (async () => {
        let acc = '';
        for await (const chunk of call(messages)) acc = collectChunk(acc, chunk);
        return acc;
      })();
      const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('模型调用超时（' + timeoutMs + 'ms）')), timeoutMs);
      });
      let text = '';
      try {
        text = await Promise.race([consume, guard]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      let parsed;
  try {
    parsed = parseDistill(text);
  } catch (err) {
    try {
      const fsMod = await import('node:fs');
      const pathMod = await import('node:path');
      const dir = pathMod.default.join(cfg.dumpDir || process.cwd(), '_distill-errors');
      fsMod.default.mkdirSync(dir, { recursive: true });
      fsMod.default.writeFileSync(pathMod.default.join(dir, 'raw-' + Date.now() + '.txt'), String(text).slice(0, 20000), 'utf8');
    } catch { /* 落盘失败忽略 */ }
    throw err;
  }
      const valid = isTurn ? validateTurn(parsed, cfg) : validateDistill(parsed, cfg);
      return { ...valid, attempts: attempt + 1, text };
    } catch (err) {
      lastErr = err;
      log(`蒸馏失败（第 ${attempt + 1} 次）：${err.message}`);
      // 解析类错误最多再试一次：同样的输入重试多次只会白白再烧几十秒
      if (/^JSON 解析失败|^输出里没有 JSON|^模型没给出|没有输出/.test(String(err?.message || ''))) {
        parseFails += 1;
        if (parseFails >= 2) break;
      }
    }
  }
  throw lastErr || new Error('蒸馏失败');
}

/** 从 .md 摘要反推记录（没有原文时兜底） */
export function recordsFromSummary(md) {
  const out = [];
  for (const line of String(md || '').split('\n')) {
    const m = line.match(/^-\s+\d{2}:\d{2}\s+你：(.*?)\s+→\s+我：(.*)$/);
    if (!m) continue;
    out.push({ role: 'user', text: m[1] });
    if (m[2] && m[2] !== '（无回复）') out.push({ role: 'assistant', text: m[2] });
  }
  return out;
}
