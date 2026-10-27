/* persona.js —— 身份层（策划书 §23.1）
   和「记忆条目」分开存：它不是一条条事实，而是「这个人是谁」，每轮都注入、不占 3 条预算。
   文件是纯 Markdown，段落用二级标题，人在面板里改、也能直接拿编辑器改。 */

import { now } from './util.js';

export const PERSONA_FILE = 'persona.md';
export const PERSONA_MAX_TOKENS = 120;

/** 字段顺序 = 文件里的段落顺序；aliases 允许手写时用别的叫法 */
export const PERSONA_FIELDS = [
  { key: 'call', head: '称呼', aliases: ['称呼', '怎么称呼', '昵称'], placeholder: '老王' },
  { key: 'lang', head: '语言', aliases: ['语言', '语言偏好', '用什么语言'], placeholder: '中文' },
  { key: 'style', head: '说话风格', aliases: ['说话风格', '风格', '语气'], placeholder: '直接，别绕' },
  { key: 'boundaries', head: '边界', aliases: ['边界', '原则', '禁忌'], placeholder: '- 不确定的事直说，别猜' },
];

const FIELD_KEYS = PERSONA_FIELDS.map((f) => f.key);

export function personaPath(store) {
  return store.dir(PERSONA_FILE);
}

export function emptyPersona() {
  const p = {};
  for (const k of FIELD_KEYS) p[k] = k === 'boundaries' ? [] : '';
  p.updated = '';
  return p;
}

export function personaEmpty(p) {
  if (!p) return true;
  return FIELD_KEYS.every((k) => (k === 'boundaries' ? !(p.boundaries || []).length : !String(p[k] || '').trim()));
}

/** 把一段文本按「## 标题」切段，标题去空格、小写后再匹配别名 */
function splitSections(text) {
  const out = new Map();
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let cur = null;
  let buf = [];
  const flush = () => {
    if (cur) out.set(cur, buf.join('\n').trim());
    buf = [];
  };
  let inFront = false;
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^---\s*$/.test(l)) {
      if (!inFront && !out.size && cur === null) { inFront = true; continue; }
      if (inFront) { inFront = false; continue; }
    }
    if (inFront) continue;
    const m = /^#{2,3}\s*(.+?)\s*$/.exec(l);
    if (m) { flush(); cur = m[1].trim(); continue; }
    if (cur) buf.push(l);
  }
  flush();
  return out;
}

export function readPersona(store) {
  const p = emptyPersona();
  let text = '';
  try { text = store.readText(personaPath(store)) || ''; } catch { return p; }
  if (!text.trim()) return p;
  const sections = splitSections(text);
  for (const f of PERSONA_FIELDS) {
    const names = [f.head, ...(f.aliases || [])];
    for (const [head, body] of sections) {
      const low = head.toLowerCase();
      if (!names.some((n) => n.toLowerCase() === low)) continue;
      if (f.key === 'boundaries') {
        p.boundaries = body
          .split('\n')
          .map((x) => x.replace(/^\s*[-*·]\s*/, '').trim())
          .filter(Boolean);
      } else {
        p[f.key] = body.replace(/\s*\n\s*/g, ' ').trim();
      }
      break;
    }
  }
  const m = /^updated:\s*(.+)$/m.exec(text);
  p.updated = m ? m[1].trim() : '';
  return p;
}

function clean(v, key) {
  if (key === 'boundaries') {
    const arr = Array.isArray(v) ? v : String(v || '').split('\n');
    return arr.map((x) => String(x).replace(/^\s*[-*·]\s*/, '').trim()).filter(Boolean).slice(0, 8);
  }
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function renderPersonaFile(p) {
  const head = ['---', 'type: persona', `updated: ${p.updated || now()}`, '---'];
  const parts = [head.join('\n')];
  for (const f of PERSONA_FIELDS) {
    const v = p[f.key];
    const body = f.key === 'boundaries' ? (v || []).map((x) => `- ${x}`).join('\n') : v || '';
    parts.push(`## ${f.head}\n${body}`.trimEnd());
  }
  return `${parts.join('\n\n').trim()}\n`;
}

/** 只写给了的字段；空字符串 = 清掉该段 */
export function writePersona(store, patch = {}) {
  const cur = readPersona(store);
  const next = { ...cur };
  for (const k of FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = clean(patch[k], k);
  }
  next.updated = now();
  store.atomicWrite(personaPath(store), renderPersonaFile(next));
  return next;
}

/** 一行式 + 边界列表；没内容返回空串。城市/时区字段已弃用（不参与渲染） */
export function renderPersona(p) {
  if (personaEmpty(p)) return '';
  const bits = [];
  if (p.call) bits.push(`称呼：${p.call}`);
  if (p.lang) bits.push(p.lang);
  if (p.style) bits.push(`风格：${p.style}`);
  const lines = [bits.join(' ｜ ')];
  for (const b of (p.boundaries || []).slice(0, 3)) lines.push(`- ${b}`);
  return lines.filter(Boolean).join('\n');
}

/** 包成围栏块；超预算就把边界行砍掉，再不行就截断主行 */
export function renderPersonaBlock(p, { maxTokens = PERSONA_MAX_TOKENS } = {}) {
  const body = renderPersona(p);
  if (!body) return '';
  const lines = body.split('\n');
  let keep = [...lines];
  const wrap = (ls) => ['<<<MY-PERSONA 关于用户，始终适用 >>>', ...ls, '<<<MY-PERSONA END>>>'].join('\n');
  while (keep.length > 1 && approxTokens(wrap(keep)) > maxTokens) keep.pop();
  let out = wrap(keep);
  if (approxTokens(out) > maxTokens) {
    const budget = Math.max(10, keep[0].length - 12);
    out = wrap([keep[0].slice(0, budget)]);
  }
  return out;
}

function approxTokens(s) {
  const t = String(s || '');
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = t.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

export default { readPersona, writePersona, renderPersona, renderPersonaBlock, personaEmpty, PERSONA_FIELDS };
