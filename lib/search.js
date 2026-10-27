/* search.js —— BM25 检索 + 索引重建（策划书 §10）
   中文按 2-gram、英文按词；字段权重 title×3 / tags×2 / body×1；
   排序再加 scope 命中、置顶、新鲜度三个乘子。
   索引坏了（版本不符/解析失败）就丢掉重建 —— 记忆本体永远是 md 文件，不怕索引丢。 */

import { tokenize, today, daysBetween, isPinned } from './util.js';
import { cosine } from './vector.js';

export const INDEX_VERSION = 1;

const K1 = 1.4;
const B = 0.72;

function fieldTerms(entry) {
  const tf = new Map();
  const add = (text, weight) => {
    for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + weight);
  };
  add(entry.title || '', 3);
  add(Array.isArray(entry.tags) ? entry.tags.join(' ') : entry.tags || '', 2);
  add(entry.body || '', 1);
  let len = 0;
  for (const v of tf.values()) len += v;
  return { tf, len };
}

/** 从条目数组建索引 */
export function buildIndex(entries) {
  const docs = entries.map((e) => {
    const { tf, len } = fieldTerms(e);
    return {
      id: e.id,
      type: e.type || 'fact',
      status: e.status || 'active',
      scope: Array.isArray(e.scope) ? e.scope : [e.scope].filter(Boolean),
      title: e.title || '',
      priority: e.priority || 'normal',
      last_used: e.last_used || e.updated || e.created || '',
      terms: Object.fromEntries(tf),
      len,
    };
  });
  const df = new Map();
  for (const d of docs) {
    for (const t of Object.keys(d.terms)) df.set(t, (df.get(t) || 0) + 1);
  }
  return {
    version: INDEX_VERSION,
    built_at: new Date().toISOString(),
    docs,
    df: Object.fromEntries(df),
    avg_len: docs.length ? docs.reduce((s, d) => s + d.len, 0) / docs.length : 0,
  };
}

/**
 * 范围匹配。第三参数 projects 是项目实体表 `[{id, paths}]`：
 * 老写法 `project:<路径>` 照旧按路径前缀匹配；新写法 `project:<实体id>` 先查实体的 paths。
 */
export function scopeMatches(docScopes, cwd, projects = []) {
  if (!cwd) return false;
  const want = String(cwd).toLowerCase().replace(/[\\/]+$/, '');
  const within = (p) => p === want || want.startsWith(`${p}\\`) || want.startsWith(`${p}/`);
  const byId = new Map((projects || []).map((p) => [String(p.id), p]));
  return docScopes.some((s) => {
    const v = String(s || '').toLowerCase().replace(/[\\/]+$/, '');
    if (!v.startsWith('project:')) return false;
    const p = v.slice('project:'.length);
    const entity = byId.get(p);
    if (entity) {
      return (entity.paths || []).some((raw) => {
        const q = String(raw || '').toLowerCase().replace(/[\\/]+$/, '');
        return q && within(q);
      });
    }
    return within(p);
  });
}

/**
 * @param {object} index buildIndex 的结果
 * @param {string} query
 * @param {{cwd?:string, includeInactive?:boolean, limit?:number, statuses?:string[],
 *          projects?:Array, vectors?:Record<string,number[]>, queryVec?:number[], alpha?:number}} opts
 */
export function search(index, query, opts = {}) {
  const q = tokenize(query);
  if (!q.length || !index || !Array.isArray(index.docs)) return [];
  const N = index.docs.length || 1;
  const avg = index.avg_len || 1;
  const uniqQ = [...new Set(q)];
  const allow = opts.statuses || (opts.includeInactive
    ? ['active', 'stale', 'superseded', 'archived', 'conflict', 'pending']
    : ['active', 'stale']);

  // 向量档：只有「查询有向量」且「该条有向量」才算；缺任何一边就纯 BM25
  const vectors = opts.vectors || null;
  const qv = Array.isArray(opts.queryVec) && opts.queryVec.length ? opts.queryVec : null;
  const alpha = qv && vectors ? Math.min(0.9, Math.max(0, Number(opts.alpha ?? 0.6))) : 0;
  // 语义相近但字面不同的条目也要能搜到，所以有向量时不因 BM25=0 就丢弃
  const minCos = Number(opts.minCos ?? 0.42);

  const scored = [];
  for (const d of index.docs) {
    if (!allow.includes(d.status)) continue;
    let bm25 = 0;
    for (const t of uniqQ) {
      const f = d.terms[t] || 0;
      if (!f) continue;
      const df = (index.df && index.df[t]) || 1;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const denom = f + K1 * (1 - B + (B * d.len) / avg);
      bm25 += idf * ((f * (K1 + 1)) / (denom || 1));
    }
    let cos = 0;
    if (alpha) {
      const v = vectors[d.id];
      if (Array.isArray(v) && v.length) cos = cosine(qv, v);
    }
    if (!alpha && bm25 <= 0) continue;
    if (alpha && bm25 <= 0 && cos < minCos) continue;
    scored.push({ ...d, bm25, cos });
  }

  const maxBm = scored.reduce((m, s) => Math.max(m, s.bm25), 0) || 1;
  for (const s of scored) {
    let score = alpha
      ? (1 - alpha) * (s.bm25 / maxBm) + alpha * Math.max(0, s.cos)
      : s.bm25;
    if (scopeMatches(s.scope, opts.cwd, opts.projects)) score *= 1.5;
    if (isPinned(s.priority)) score *= 2;
    const age = s.last_used ? daysBetween(s.last_used, today()) : 999;
    if (age >= 0 && age <= 90) score *= 1.2;
    s.score = score;
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit ?? 10);
}

/** 把索引重建写回磁盘；entries 由 store 提供 */
export function rebuild(store) {
  const entries = store.all();
  const idx = buildIndex(entries);
  store.writeIndex(idx);
  return idx;
}

/** 读索引；没有/坏了就重建 */
export function ensureIndex(store) {
  const existing = store.readIndex();
  if (existing && existing.version === INDEX_VERSION && Array.isArray(existing.docs)) {
    // docs 数量与磁盘条目数差太多 ⇒ 认为过期
    const live = store.all().length;
    if (existing.docs.length === live) return existing;
  }
  return rebuild(store);
}
