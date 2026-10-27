/* util.js —— 零依赖的小工具：frontmatter 读写、文本归一、相似度、分词
   这个插件不引第三方依赖（整包只有 .js 和 .md），所以下面都是手写的。 */

import { createHash } from 'node:crypto';

/* ---------- 时间 ---------- */

/** 本地时间戳 `2026-10-25T21:48`，不带秒 —— 记忆不需要秒级精度 */
export function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `2026-10-25` */
export function today(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 两个 `YYYY-MM-DD...` 之间差几天（b - a） */
export function daysBetween(a, b) {
  const t = (s) => {
    const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
    return Date.UTC(y, (m || 1) - 1, d || 1);
  };
  return Math.round((t(b) - t(a)) / 86400000);
}

/* ---------- frontmatter ----------
   只支持我们自己的子集：`key: value`，值可以是字符串、数字、空串、`[]`、`[a, b]`、`''`。
   不引 yaml 包；写出来的格式固定，读回来一定对得上。 */

const FM_ORDER = [
  'id', 'type', 'scope', 'status', 'title', 'priority', 'created', 'updated',
  'source', 'hits', 'last_used', 'supersedes', 'superseded_by', 'source_trust', 'tags',
];

function fmtValue(key, v) {
  if (Array.isArray(v)) return `[${v.map((x) => String(x)).join(', ')}]`;
  if (v === null || v === undefined) return '';
  if (key === 'hits') return String(Number(v) || 0);
  return String(v);
}

function parseValue(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return '';
  if (s === '[]') return [];
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  return s.replace(/^['"]|['"]$/g, '');
}

/** 把一条记忆序列化成 md 文本 */
export function serialize(entry) {
  const fm = [];
  for (const key of FM_ORDER) {
    if (entry[key] === undefined) continue;
    fm.push(`${key}: ${fmtValue(key, entry[key])}`);
  }
  for (const [k, v] of Object.entries(entry)) {
    if (FM_ORDER.includes(k) || k === 'body' || k === 'file') continue;
    if (v === undefined) continue;
    fm.push(`${k}: ${fmtValue(k, v)}`);
  }
  const body = String(entry.body ?? '').replace(/\r\n/g, '\n').trim();
  return `---\n${fm.join('\n')}\n---\n\n${body}\n`;
}

/** 解析 md 文本 → { ...frontmatter, body }；坏文件返回 null */
export function parse(text) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---')) {
    return { body: src.trim() };
  }
  const end = src.indexOf('\n---', 3);
  if (end < 0) return { body: src.trim() };
  const head = src.slice(3, end).trim();
  const body = src.slice(src.indexOf('\n', end + 4) + 1).trim();
  const out = { body };
  for (const line of head.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (!key) continue;
    out[key] = parseValue(line.slice(i + 1));
  }
  return out;
}

/* ---------- 文本归一 ---------- */

/** 压成单行、去掉多余空白 —— 用于标题和"为什么抓它" */
export function oneline(s, max = 0) {
  let t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (max > 0 && t.length > max) t = `${t.slice(0, max - 1)}…`;
  return t;
}

/** 截断到 n 个字符（中文按字算），超出加省略号 */
export function clip(s, n) {
  const t = String(s ?? '');
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/** 归一成用于比较的字符串：小写、去标点、全角转半角、压空白 */
export function norm(s) {
  return String(s ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------- 相似度：字符 3-gram 余弦 ---------- */

export function grams(s, n = 3) {
  const t = norm(s).replace(/\s+/g, '');
  const out = new Map();
  if (!t) return out;
  if (t.length <= n) {
    out.set(t, 1);
    return out;
  }
  for (let i = 0; i + n <= t.length; i += 1) {
    const g = t.slice(i, i + n);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/** 余弦相似度 0..1 */
export function similarity(a, b) {
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let dot = 0;
  for (const [g, x] of A) {
    const y = B.get(g);
    if (y) dot += x * y;
  }
  let na = 0;
  for (const x of A.values()) na += x * x;
  let nb = 0;
  for (const y of B.values()) nb += y * y;
  return nodot(dot, na, nb);
}

function nodot(dot, na, nb) {
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

/* ---------- 分词：中文 2-gram + 英文词 ---------- */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

export function tokenize(s) {
  const t = norm(s);
  const out = [];
  const words = t.split(' ');
  for (const w of words) {
    if (!w) continue;
    // 把一段里连续的中文和连续的英文数字分开切
    let buf = '';
    let bufCjk = null;
    const flush = () => {
      if (buf) {
        if (bufCjk) {
          if (buf.length === 1) out.push(buf);
          else for (let i = 0; i + 2 <= buf.length; i += 1) out.push(buf.slice(i, i + 2));
        } else {
          out.push(buf);
        }
      }
      buf = '';
    };
    for (const ch of w) {
      const isCjk = CJK.test(ch);
      if (bufCjk === null) bufCjk = isCjk;
      else if (isCjk !== bufCjk) {
        flush();
        bufCjk = isCjk;
      }
      buf += ch;
    }
    flush();
  }
  return out;
}

/* ---------- 杂项 ---------- */

export function sha1(s) {
  return createHash('sha1').update(String(s)).digest('hex');
}

/** 编号 41 → "0041" */
export function padId(n, width = 4) {
  return String(n).padStart(width, '0');
}

/** 文件名安全化：去掉非法字符与空格，中文保留 */
export function safeName(s, max = 40) {
  return String(s ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max) || 'entry';
}

/** 粗估 token：中文 1 字 ≈ 1 token，英文 4 字符 ≈ 1 token（够用了，宁多不少） */
export function approxTokens(s) {
  const t = String(s ?? '');
  let cjk = 0;
  let other = 0;
  for (const ch of t) {
    if (CJK.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** 置顶判定：库里既有数字 0/1/2，也有老的字符串 pinned/high */
export function isPinned(priority) {
  if (priority === 'pinned' || priority === 'high') return true
  return Number(priority) >= 2
}

/** 把任意写法归一成数字 0/1/2；认不出来返回 undefined */
export function normalizePriority(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(2, Math.round(v)))
  const s = String(v ?? '').trim().toLowerCase()
  if (s === 'pinned' || s === 'high' || s === '2') return 2
  if (s === 'normal' || s === '1') return 1
  if (s === 'low' || s === '0') return 0
  return undefined
}
