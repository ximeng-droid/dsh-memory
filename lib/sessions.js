/**
 * L0 · 原始对话采集
 *
 * 只做「把一段对话按会话落成三个文件」，不碰宿主 API、不调模型，
 * 这样单测可以直接给假数据跑。
 *
 *   _sessions\<YYYY-MM-DD>\<sessionId>.jsonl.zst   原文（保留 retainDays 天）
 *   _sessions\<YYYY-MM-DD>\<sessionId>.md          每轮一行的摘要（永久）
 *   _sessions\<YYYY-MM-DD>\<sessionId>.meta.json   元信息（永久）
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const SESSIONS_DIR = '_sessions';
export const DEBUG_FILE = '.sessions-debug.json';
export const DEFAULT_RETAIN_DAYS = 90;

/** 本地日期 YYYY-MM-DD（用本地时区，跟日记一致） */
export function dayOf(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return dayOf(new Date());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 会话 id 可能带奇怪字符（宿主给的通常是 session-<hex>），统一洗一遍 */
export function safeId(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return s || 'session-unknown';
}

export function sessionsRoot(store) {
  return path.join(store.root, SESSIONS_DIR);
}

export function sessionPaths(store, { id, day }) {
  const d = day || dayOf();
  const base = safeId(id);
  const dir = path.join(store.root, SESSIONS_DIR, d);
  return {
    dir,
    base,
    raw: path.join(dir, `${base}.jsonl.zst`),
    md: path.join(dir, `${base}.md`),
    meta: path.join(dir, `${base}.meta.json`),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** 把 [{role,text}] 写成 jsonl 再 zstd 压盘，返回 {raw, bytes, compressed} */
export function writeRaw(store, { id, day, records }) {
  const p = sessionPaths(store, { id, day });
  ensureDir(p.dir);
  const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const buf = zlib.zstdCompressSync(Buffer.from(jsonl, 'utf8'));
  atomicWrite(p.raw, buf);
  return { raw: p.raw, bytes: Buffer.byteLength(jsonl), compressed: buf.length, records: records.length };
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 把「多帧追加」的 zstd 文件按 magic 切帧，逐帧解压后拼起来 */
export function decodeFrames(buf) {
  const starts = [];
  let i = buf.indexOf(ZSTD_MAGIC, 0);
  while (i >= 0) {
    starts.push(i);
    i = buf.indexOf(ZSTD_MAGIC, i + 4);
  }
  if (starts.length <= 1) return zlib.zstdDecompressSync(buf).toString('utf8');
  const parts = [];
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8'));
    } catch {
      // 最后一帧可能还没写完，忽略
    }
  }
  return parts.join('');
}

/**
 * 追加一帧（每轮落档用）：不整份重压，只把这段新记录压成一帧接到文件末尾。
 * 这样一轮的代价是 O(这一轮)，跟会话已经多长无关。
 */
export function appendRaw(store, { id, day }, records) {
  const p = sessionPaths(store, { id, day });
  ensureDir(p.dir);
  const list = (records || []).filter(Boolean);
  if (!list.length) return { added: 0, bytes: 0, compressed: 0 };
  const jsonl = list.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const buf = zlib.zstdCompressSync(Buffer.from(jsonl, 'utf8'));
  fs.appendFileSync(p.raw, buf);
  return { added: list.length, bytes: Buffer.byteLength(jsonl), compressed: buf.length };
}

/** 读回原文（测试与「回溯这段对话」用；兼容单帧与多帧追加） */
export function readRaw(store, { id, day }) {
  const p = sessionPaths(store, { id, day });
  if (!fs.existsSync(p.raw)) return null;
  const text = decodeFrames(fs.readFileSync(p.raw));
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** 摘要文件：追一行（首行给个标题） */
export function appendSummary(store, { id, day, line, title }) {
  const p = sessionPaths(store, { id, day });
  ensureDir(p.dir);
  if (!fs.existsSync(p.md)) {
    fs.writeFileSync(p.md, `# ${title || safeId(id)}\n\n`, 'utf8');
  }
  if (line != null && String(line).trim() !== '') {
    fs.appendFileSync(p.md, `${line}\n`, 'utf8');
  }
  return p.md;
}

export function readSummary(store, { id, day }) {
  const p = sessionPaths(store, { id, day });
  return fs.existsSync(p.md) ? fs.readFileSync(p.md, 'utf8') : '';
}

export function writeMeta(store, meta) {
  const p = sessionPaths(store, { id: meta.id, day: meta.day });
  ensureDir(p.dir);
  atomicWrite(p.meta, JSON.stringify(meta, null, 2));
  return p.meta;
}

export function readMeta(store, { id, day }) {
  const p = sessionPaths(store, { id, day });
  if (!fs.existsSync(p.meta)) return null;
  try {
    return JSON.parse(fs.readFileSync(p.meta, 'utf8'));
  } catch {
    return null;
  }
}

/** 列出所有会话（按日期倒序，新的在前） */
export function listSessions(store) {
  const root = sessionsRoot(store);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const day of fs.readdirSync(root).sort().reverse()) {
    const dir = path.join(root, day);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.meta.json')) continue;
      const meta = (() => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        } catch {
          return null;
        }
      })();
      const base = f.replace(/\.meta\.json$/, '');
      out.push({
        day,
        id: base,
        meta,
        raw: path.join(dir, `${base}.jsonl.zst`),
        md: path.join(dir, `${base}.md`),
        hasRaw: fs.existsSync(path.join(dir, `${base}.jsonl.zst`)),
      });
    }
  }
  return out;
}

/**
 * 删掉超期的原文，md 与 meta 不动。
 * now 可传字符串/Date，方便测试。
 */
export function pruneRaw(store, { days = DEFAULT_RETAIN_DAYS, now = new Date() } = {}) {
  const root = sessionsRoot(store);
  if (!fs.existsSync(root)) return { removed: [], kept: 0 };
  const today = new Date(now);
  const removed = [];
  let kept = 0;
  for (const day of fs.readdirSync(root)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const dir = path.join(root, day);
    const ageDays = Math.floor((today - new Date(`${day}T00:00:00`)) / 86400000);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl.zst')) continue;
      if (ageDays > days) {
        fs.unlinkSync(path.join(dir, f));
        removed.push(`${day}/${f}`);
      } else {
        kept += 1;
      }
    }
  }
  return { removed, kept };
}

/** 从宿主 messages 里挑出人话（user + assistant 的纯文本） */
export function buildRecords(messages, { max = 400 } = {}) {
  const out = [];
  for (const m of messages || []) {
    const role = m?.role || m?.type;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = flattenText(m?.content ?? m?.text);
    if (!text.trim()) continue;
    out.push({ role, text });
    if (out.length >= max) break;
  }
  return out;
}

function flattenText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return part.text || '';
      if (part.type === 'tool-call' || part.type === 'tool-result') return '';
      if (Array.isArray(part.content)) return flattenText(part.content);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 从宿主 session/flush 的 log 事件流里抽真实对话。
 * 只认 user/message 与 assistant/message，丢掉工具调用、空回复、系统注入。
 */
export function extractConversation(events, { isInjected = () => false, max = 400 } = {}) {
  const out = []
  for (const ev of events || []) {
    const type = ev?.type
    if (type !== 'user/message' && type !== 'assistant/message') continue
    const data = ev?.data || {}
    const role = type === 'user/message' ? 'user' : 'assistant'
    const raw = role === 'user' ? (data.content ?? data.message?.content) : (data.message?.content ?? data.content)
    const text = flattenText(raw).trim()
    if (!text) continue
    if (role === 'user' && isInjected(text)) continue
    out.push({ role, text, at: ev?.time || ev?.at || null })
    if (out.length > max) out.shift()
  }
  // 丢掉「接在系统注入后面」的回答：它们不是对用户说的
  const kept = []
  let waiting = false
  for (const rec of out) {
    if (rec.role === 'user') {
      waiting = true
      kept.push(rec)
    } else if (waiting) {
      kept.push(rec)
      waiting = false
    }
  }
  const clean = []
  for (const rec of kept) {
    const prev = clean[clean.length - 1]
    if (prev && prev.role === rec.role && prev.text === rec.text) continue
    clean.push(rec)
  }
  return clean
}

/** 会话里第一条真人说的话（用来给会话起标题，不受 tail 截断影响） */
export function firstUser(events, { isInjected = () => false, maxScan = 400 } = {}) {
  let n = 0
  for (const ev of events || []) {
    if (n++ > maxScan) break
    if (ev?.type !== 'user/message') continue
    const data = ev?.data || {}
    const text = flattenText(data.content ?? data.message?.content).trim()
    if (!text || isInjected(text)) continue
    // 标题不要「会话 id」「uuid」这类没信息量的开头
    if (text.length < 4 || /^session-|^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text)) continue
    return text
  }
  return ''
}
/** 把 [{role,text}] 变成「你：… → 我：…」成对的行（没回复的单独一行） */
export function pairLines(records) {
  const lines = []
  let pending = null
  for (const rec of records) {
    if (rec.role === 'user') {
      if (pending) lines.push(summaryLine(pending, '', rec.at ? new Date(rec.at) : new Date()))
      pending = rec.text
    } else if (rec.role === 'assistant') {
      lines.push(summaryLine(pending || '', rec.text, rec.at ? new Date(rec.at) : new Date()))
      pending = null
    }
  }
  if (pending) lines.push(summaryLine(pending, '', new Date()))
  return lines
}

/** 覆写摘要文件（首行标题 + 若干行） */
export function writeSummary(store, { id, day, title, lines }) {
  const p = sessionPaths(store, { id, day })
  ensureDir(p.dir)
  const head = '# ' + (title || safeId(id)) + '\n\n'
  const body = (lines || []).filter(Boolean).join('\n')
  atomicWrite(p.md, head + (body ? body + '\n' : ''))
  return p.md
}

/** 摘要行：`- 18:42 你：… → 我：…` */
export function summaryLine(userText, assistantText, at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  const hhmm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return `- ${hhmm} 你：${clip(userText, 60) || '（空）'} → 我：${clip(assistantText, 120) || '（无回复）'}`;
}

/**
 * 采集事件探针：把每次触发的时间、事件名、载荷里能看的字段记下来，
 * 供 4E-1 判断「会话结束」到底该挂哪个事件。
 */
export function noteDebug(store, entry) {
  const file = path.join(store.root, DEBUG_FILE);
  let data = { since: new Date().toISOString(), events: [] };
  if (fs.existsSync(file)) {
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (prev && Array.isArray(prev.events)) data = prev;
    } catch {
      /* 坏了就重来 */
    }
  }
  data.events.push({ at: new Date().toISOString(), ...entry });
  if (data.events.length > 200) data.events = data.events.slice(-200);
  try {
    atomicWrite(file, JSON.stringify(data, null, 2));
  } catch {
    /* 探针失败绝不影响主流程 */
  }
  return data.events.length;
}

export function readDebug(store) {
  const file = path.join(store.root, DEBUG_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 给探针用的浅层形状描述（不递归，不落全文） */
export function shapeOf(obj, depth = 1) {
  if (obj == null) return obj;
  if (typeof obj !== 'object') return typeof obj;
  if (Array.isArray(obj)) return `array(${obj.length})`;
  if (depth <= 0) return 'object';
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'function') continue;
    if (v == null) out[k] = null;
    else if (Array.isArray(v)) out[k] = `array(${v.length})`;
    else if (typeof v === 'object') out[k] = depth > 1 ? shapeOf(v, depth - 1) : 'object';
    else out[k] = typeof v === 'string' ? clip(v, 40) : v;
  }
  return out;
}

/**
 * 从会话事件流里挑出「用户自己发来的图/文件」（§26.7：只记指纹，不存图）。
 * 形状（宿主实测）：user/message 的 content 里 { type:'image', attachment:{ attachmentId:'sha256:…', mediaType, bytes, width, height, name } }
 * 工具结果里的图不算（那是我自己截的屏）。
 */
/** 只取「最后一条 user/message」里的图 —— 闸门判据要用本轮的附件，不是整段历史的 */
export function lastUserImages(events = []) {
  const list = Array.isArray(events) ? events : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type !== 'user/message') continue
    return userImages([list[i]])
  }
  return []
}

export function userImages(events = []) {
  const out = []
  const seen = new Set()
  for (const ev of events || []) {
    if (String(ev?.type || '') !== 'user/message') continue
    const parts = ev?.data?.content
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (String(part?.type || '') !== 'image') continue
      const a = part?.attachment || {}
      const sha = String(a.attachmentId || '').slice(0, 21) // 'sha256:' + 14 位够认
      if (!sha || seen.has(sha)) continue
      seen.add(sha)
      out.push({
        sha,
        media: String(a.mediaType || ''),
        bytes: Number(a.bytes || 0),
        name: String(a.name || '').slice(0, 80),
      })
    }
  }
  return out
}

/**
 * 冷会话兜底挑选（§26.5）——纯函数，方便测。
 * 判据：凉了 ≥ coldAfterMin 分钟、没蒸过（没 .distill.json）、不在队列里、至少有 1 个来回。
 * 不看轮数：一两轮就结束的会话也可能定过规矩。
 */
export function pickColdSessions(list = [], { now = Date.now(), coldAfterMin = 30, max = 2, minTurns = 1, isDistilled = () => false, countTurns = () => 0, inQueue = () => false } = {}) {
  const mins = Number(coldAfterMin)
  const cap = Number(max)
  if (!(mins > 0) || !(cap > 0)) return []
  const out = []
  for (const one of list || []) {
    if (!one?.id || !one?.day) continue
    if (inQueue(one)) continue
    if (isDistilled(one)) continue
    const stamp = String(one?.meta?.ended || one?.meta?.started || '').replace(' ', 'T')
    const at = Date.parse(stamp) || 0
    if (!at || now - at < mins * 60000) continue
    const turns = Number(countTurns(one)) || 0
    if (turns < Math.max(1, Number(minTurns) || 1)) continue
    out.push({ ...one, at, turns })
  }
  out.sort((a, b) => a.at - b.at) // 最老的先补
  return out.slice(0, cap)
}
