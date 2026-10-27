/* suggest.js —— L4 画像「建议」（策划书 §24.7）
   只给候选，不自动写。每条必须带 2 条以上来源，否则不出——宁可不建议，也不瞎猜。
   落盘：<记忆库>\_suggestions.json = { version:1, at, items:[…], dismissed:[id] } */
import fs from 'node:fs';
import path from 'node:path';

import { clip, now } from './util.js';
import { renderPersona, readPersona, writePersona } from './persona.js';

export const SUGGEST_FILE = '_suggestions.json';
export const SUGGEST_VERSION = 1;

export function suggestPath(store) {
  return path.join(store.root, SUGGEST_FILE);
}

export function emptySuggestions() {
  return { version: SUGGEST_VERSION, at: '', items: [], dismissed: [] };
}

export function readSuggestions(store) {
  try {
    const raw = JSON.parse(fs.readFileSync(suggestPath(store), 'utf8'));
    if (!raw || typeof raw !== 'object') return emptySuggestions();
    return {
      version: raw.version || SUGGEST_VERSION,
      at: raw.at || '',
      items: Array.isArray(raw.items) ? raw.items : [],
      dismissed: Array.isArray(raw.dismissed) ? raw.dismissed : [],
    };
  } catch {
    return emptySuggestions();
  }
}

export function writeSuggestions(store, data) {
  const next = { ...emptySuggestions(), ...data, version: SUGGEST_VERSION };
  store.atomicWrite(suggestPath(store), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/* ---------- 规则 ---------- */

/** 工具名：只在「用法/偏好」语境里算数 */
const TOOLS = ['pnpm', 'npm', 'yarn', 'bun', 'curl', 'wget', 'git', 'node', 'python', 'uv', 'pwsh', 'bash'];
const STYLE_WORDS = ['先给结论', '别绕', '直接说', '简洁', '少解释', '别废话', '短一点'];
const NEG = /(别用|不要用|不用|禁用|换成|改成|而不是)/;

/** 某个工具在文本里出现的次数与「被否定」的次数（看命中位置前 10 个字） */
function toolSentiment(text, tool) {
  const low = String(text || '').toLowerCase();
  const re = new RegExp(`(^|[^a-z])${tool}([^a-z]|$)`, 'g');
  let m;
  let count = 0;
  let negative = 0;
  while ((m = re.exec(low)) !== null) {
    count += 1;
    const before = low.slice(Math.max(0, m.index - 10), m.index + 1);
    if (NEG.test(before)) negative += 1;
    if (re.lastIndex <= m.index) re.lastIndex = m.index + 1;
  }
  return { count, negative };
}

/**
 * 从条目里推候选。
 * @returns {Array<{id,field,value,reason,sources}>}
 */
export function deriveSuggestions(store, { entries = [], minSources = 2, limit = 4 } = {}) {
  const persona = readPersona(store);
  const have = `${persona.style || ''}\n${(persona.boundaries || []).join('\n')}`.toLowerCase();
  const pool = entries.filter((e) => ['preference', 'forbidden', 'decision', 'profile'].includes(e.type));
  const out = [];

  // R1：同一个工具在多条「以后都用/别用」里出现 ⇒ 建议一条硬规则（按该工具自身的语气判正负）
  const toolHits = new Map(); // tool -> {yes:[], no:[]}
  for (const e of pool) {
    const text = `${e.title} ${e.body}`;
    if (!/以后都|统一|一律|都用|别用|不要用|禁用/.test(text)) continue;
    for (const tool of TOOLS) {
      const { count, negative } = toolSentiment(text, tool);
      if (!count) continue;
      const slot = toolHits.get(tool) || { yes: [], no: [] };
      if (negative) slot.no.push(e);
      else slot.yes.push(e);
      toolHits.set(tool, slot);
    }
  }
  for (const [tool, slot] of [...toolHits.entries()].sort((a, b) => (b[1].yes.length + b[1].no.length) - (a[1].yes.length + a[1].no.length))) {
    if (slot.yes.length >= minSources) {
      const value = `一律用 ${tool}`;
      if (!have.includes(value)) {
        out.push({
          id: `sg-${tool}-yes`,
          field: 'boundaries',
          value,
          reason: `${slot.yes.length} 条记忆都说用 ${tool}`,
          sources: slot.yes.slice(0, 5).map((e) => String(e.id)),
        });
      }
    }
    if (slot.no.length >= minSources) {
      const value = `不要用 ${tool}`;
      if (!have.includes(value)) {
        out.push({
          id: `sg-${tool}-no`,
          field: 'boundaries',
          value,
          reason: `${slot.no.length} 条记忆都说别用 ${tool}`,
          sources: slot.no.slice(0, 5).map((e) => String(e.id)),
        });
      }
    }
  }

  // R2：说话风格线索（≥2 条才提）
  const styleHits = new Map();
  for (const e of entries) {
    const text = `${e.title} ${e.body}`;
    for (const w of STYLE_WORDS) {
      if (!text.includes(w)) continue;
      const list = styleHits.get(w) || [];
      list.push(e);
      styleHits.set(w, list);
    }
  }
  for (const [w, list] of [...styleHits.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (list.length < minSources) continue;
    if ((persona.style || '').includes(w)) continue;
    out.push({
      id: `sg-style-${encodeURIComponent(w)}`,
      field: 'style',
      value: persona.style ? `${persona.style}，${w}` : w,
      reason: `${list.length} 条记忆里的说法`,
      sources: list.slice(0, 5).map((e) => String(e.id)),
    });
    break;
  }

  return out.slice(0, limit);
}

/** 刷新建议列表：已有建议保留原 id（不重复堆），被忽略过的永不再提 */
export function refreshSuggestions(store, { entries = [], limit = 4 } = {}) {
  const old = readSuggestions(store);
  const dismissed = new Set(old.dismissed || []);
  const prev = new Map((old.items || []).map((x) => [x.id, x]));
  const fresh = deriveSuggestions(store, { entries, limit }).filter((s) => !dismissed.has(s.id));
  const items = fresh.map((s) => ({ ...s, at: prev.get(s.id)?.at || now(), value: s.value }));
  writeSuggestions(store, { ...old, at: now(), items, dismissed: [...dismissed] });
  return { items, dismissed: [...dismissed] };
}

/** 采纳：写进 persona.md（boundaries 追加、style 覆盖），并从建议里移除 */
export function acceptSuggestion(store, id) {
  const data = readSuggestions(store);
  const hit = (data.items || []).find((x) => x.id === id);
  if (!hit) throw new Error(`没有这条建议：${id}`);
  const persona = readPersona(store);
  if (hit.field === 'boundaries') {
    const list = [...(persona.boundaries || [])];
    if (!list.includes(hit.value)) list.push(hit.value);
    writePersona(store, { boundaries: list.slice(0, 8) });
  } else if (hit.field === 'style') {
    writePersona(store, { style: String(hit.value).slice(0, 60) });
  } else {
    throw new Error(`不认识的建议字段：${hit.field}`);
  }
  data.items = (data.items || []).filter((x) => x.id !== id);
  writeSuggestions(store, data);
  return { id, persona: renderPersona(readPersona(store)) };
}

/** 忽略：记进 dismissed，永不再提 */
export function dismissSuggestion(store, id) {
  const data = readSuggestions(store);
  data.items = (data.items || []).filter((x) => x.id !== id);
  data.dismissed = [...new Set([...(data.dismissed || []), id])];
  writeSuggestions(store, data);
  return { id, dismissed: data.dismissed.length };
}

export function suggestionLine(s) {
  return `- ${s.field === 'style' ? '说话风格' : '硬规则'}：${clip(s.value, 60)}（${s.reason}）`;
}
