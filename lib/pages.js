/* pages.js —— 知识页 / 专题合并（策划书 §23.4，4E-5 升级为 Hindsight 式）
   确定性版本：不调模型也能出一页；有模型时的润色由 service.composeTopic 传 scenes 进来。
   结构固定五段：是什么 / 约定 / 决策与理由 / 已知的坑 / 相关页 —— 每条尽量带 (id) 以便反链。 */
import fs from 'node:fs';
import path from 'node:path';

import { clip, now, today, isPinned } from './util.js';

export const PAGES_DIR = 'pages';
export const PAGE_INDEX = 'index.md';
export const PAGE_HISTORY = '_history';
export const PAGE_SECTIONS = ['是什么', '约定', '决策与理由', '已知的坑', '相关页'];

/** 标题 → 文件名：汉字与字母数字保留，其余折成 - */
export function slugOf(topic, max = 32) {
  const stem = String(topic || '')
    .trim()
    .replace(/[^\p{Script=Han}\w]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return stem || `page-${Date.now().toString(36)}`;
}

export function pagesDir(store) {
  return store.dir(PAGES_DIR);
}

export function historyDir(store) {
  return path.join(pagesDir(store), PAGE_HISTORY);
}

export function pageFile(store, slug) {
  return path.join(pagesDir(store), `${slug}.md`);
}

function parseValue(v) {
  const s = String(v || '').trim();
  if (/^\[.*\]$/.test(s)) {
    return s.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  const bare = s.replace(/^["']|["']$/g, '');
  if (bare === 'true') return true;
  if (bare === 'false') return false;
  return bare;
}

export function readPage(store, slug) {
  try {
    const raw = fs.readFileSync(pageFile(store, slug), 'utf8');
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    if (!m) return null;
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([a-z_]+):\s*(.*)$/i.exec(line);
      if (!kv) continue;
      meta[kv[1]] = parseValue(kv[2]);
    }
    return {
      ...meta,
      slug,
      body: m[2].trim(),
      file: path.posix.join(PAGES_DIR, `${slug}.md`),
      needs_recompose: meta.needs_recompose === true,
      sources: Array.isArray(meta.sources) ? meta.sources : [],
      scenes: Array.isArray(meta.scenes) ? meta.scenes : [],
      related: Array.isArray(meta.related) ? meta.related : [],
    };
  } catch {
    return null;
  }
}

export function listPages(store) {
  let names = [];
  try {
    names = fs.readdirSync(pagesDir(store)).filter((f) => f.endsWith('.md') && f !== PAGE_INDEX);
  } catch {
    return [];
  }
  return names.map((f) => readPage(store, f.replace(/\.md$/, ''))).filter(Boolean);
}

/** 只取正文首句，避免页变成第二条记忆 */
function firstSentence(text, max = 90) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const cut = s.split(/(?<=[。！？；;.!?])\s*/)[0] || s;
  return clip(cut, max);
}

/** 哪些页引用了这些条目（删条目 / 取代时要标「需重煮」） */
export function pagesUsing(store, ids) {
  const set = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
  return listPages(store).filter((p) => p.sources.some((id) => set.has(String(id))));
}

/** 相关页：按「共同来源」自动连边，取前 6 个 */
export function relatedPages(store, slug, sources) {
  const own = new Set((sources || []).map(String));
  return listPages(store)
    .filter((p) => p.slug !== slug)
    .map((p) => ({ p, shared: p.sources.filter((id) => own.has(String(id))).length }))
    .filter((x) => x.shared > 0)
    .sort((a, b) => b.shared - a.shared || String(b.p.updated).localeCompare(String(a.p.updated)))
    .slice(0, 6)
    .map((x) => x.p.slug);
}

const CONVICTION = ['preference', 'forbidden', 'decision', 'profile'];
const PITFALL = /坑|失败|不能|别|报错|踩|避免|注意/;

/**
 * 煮一页：条目按语义分到五段里，场景作为「经历」的补充。
 * @returns {{slug:string, page:object, sources:string[]}|null}
 */
export function composePage(store, { topic, entries, scenes = [], maxSources = 12, related = [] } = {}) {
  const name = String(topic || '').trim();
  if (!name) return null;
  const sources = (entries || [])
    .slice(0, maxSources)
    .filter((e) => e && e.status !== 'rejected' && e.status !== 'archived');
  if (!sources.length) return null;

  const slug = slugOf(name);
  const pick = (types) => sources
    .filter((e) => types.includes(e.type || 'fact'))
    .sort((a, b) => (isPinned(b.priority) ? 2 : Number(b.priority) || 0) - (isPinned(a.priority) ? 2 : Number(a.priority) || 0)
      || String(b.last_used || b.updated || '').localeCompare(String(a.last_used || a.updated || '')));

  const line = (e) => {
    const head = firstSentence(e.title || e.body, 80);
    const why = e.why ? ` —— ${clip(String(e.why).replace(/\s+/g, ' '), 60)}` : '';
    return `- ${head}（${e.id}）${why}`;
  };

  const sections = [];

  // 是什么：一句话 + 规模
  const head = pick(['fact', 'knowledge', 'project'])[0] || sources[0];
  sections.push(`## 是什么\n${firstSentence(head.title || head.body, 100)}（${head.id}）\n\n由 ${sources.length} 条记忆${scenes.length ? `、${scenes.length} 个场景` : ''}汇总。`);

  // 约定
  const conv = pick(CONVICTION);
  if (conv.length) sections.push(`## 约定\n${conv.slice(0, 8).map((e) => line(e)).join('\n')}`);

  // 决策与理由（含被顶掉的旧值）
  const decided = pick(['decision']);
  const superseded = sources.filter((e) => e.status === 'superseded' || e.superseded_by);
  if (decided.length || superseded.length) {
    const rows = decided.slice(0, 6).map((e) => line(e));
    for (const e of superseded.slice(0, 4)) {
      const when = String(e.updated || e.created || '').slice(5, 10);
      rows.push(`- ${firstSentence(e.title || e.body, 60)}（${e.id}）—— 原：${clip(String(e.body || '').replace(/\s+/g, ' '), 50)}，${when} 起作废`);
    }
    sections.push(`## 决策与理由\n${rows.join('\n')}`);
  }

  // 已知的坑
  const pitfalls = [
    ...pick(['experience']),
    ...sources.filter((e) => !['experience'].includes(e.type) && PITFALL.test(`${e.title} ${e.body}`)),
  ].slice(0, 8);
  const scenePitfalls = (scenes || [])
    .map((s) => String(s.pitfalls || '').trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((t) => `- ${clip(t.replace(/\s+/g, ' '), 100)}`);
  if (pitfalls.length || scenePitfalls.length) {
    sections.push(`## 已知的坑\n${[...pitfalls.map((e) => line(e)), ...scenePitfalls].join('\n')}`);
  }

  // 相关页
  const autoRelated = relatedPages(store, slug, sources.map((e) => e.id));
  const relSlugs = [...new Set([...(related || []), ...autoRelated])].filter((s) => s && s !== slug).slice(0, 6);
  if (relSlugs.length) sections.push(`## 相关页\n${relSlugs.map((s) => `- [[page:${s}]]`).join('\n')}`);

  const body = sections.join('\n\n');
  const existing = readPage(store, slug);
  const description = clip(`${clip(name, 24)}：${firstSentence(head.title || head.body, 60)}`, 80);
  const page = {
    type: 'page',
    slug,
    title: name.slice(0, 40),
    description,
    related: relSlugs,
    topics: [...new Set([name, ...relSlugs.slice(0, 3)])].slice(0, 6),
    sources: sources.map((e) => String(e.id)),
    scenes: (scenes || []).map((s) => String(s.id || '')).filter(Boolean).slice(0, 8),
    status: 'active',
    needs_recompose: false,
    created: existing?.created || now(),
    updated: now(),
    body,
    file: path.posix.join(PAGES_DIR, `${slug}.md`),
  };
  return { slug, page, sources: page.sources };
}

function renderPageFile(page) {
  const arr = (v) => `[${(Array.isArray(v) ? v : []).map((x) => JSON.stringify(String(x))).join(', ')}]`;
  return [
    '---',
    'type: page',
    `slug: ${page.slug}`,
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(page.description || '')}`,
    `related: ${arr(page.related)}`,
    `topics: ${arr(page.topics)}`,
    `sources: ${arr(page.sources)}`,
    `scenes: ${arr(page.scenes)}`,
    `status: ${page.status || 'active'}`,
    `needs_recompose: ${page.needs_recompose ? 'true' : 'false'}`,
    `created: ${page.created}`,
    `updated: ${page.updated}`,
    '---',
    '',
    page.body,
    '',
  ].join('\n');
}

/** 旧版进 pages/_history/，只在内容真的变了时留档 */
function archiveOld(store, slug, nextBody) {
  const old = readPage(store, slug);
  if (!old) return false;
  if (String(old.body || '').trim() === String(nextBody || '').trim()) return false;
  const dir = historyDir(store);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = String(old.updated || now()).replace(/[^\d]/g, '').slice(0, 12);
  store.atomicWrite(path.join(dir, `${slug}-${stamp || Date.now()}.md`), renderPageFile(old));
  return true;
}

/** 落盘：同 slug 幂等更新，并把来源条目的 page 字段写回 slug（不动来源正文） */
export function savePage(store, page, { trigger = 'page' } = {}) {
  const dir = pagesDir(store);
  fs.mkdirSync(dir, { recursive: true });
  archiveOld(store, page.slug, page.body);
  store.atomicWrite(pageFile(store, page.slug), renderPageFile(page));
  let backlinked = 0;
  for (const id of page.sources || []) {
    const e = store.byId(id);
    if (!e) continue;
    const pages = new Set(String(e.page || '').split(',').map((s) => s.trim()).filter(Boolean));
    if (pages.has(page.slug)) continue;
    pages.add(page.slug);
    store.move(e, { page: [...pages].join(','), updated: now() }, { trigger });
    backlinked += 1;
  }
  writePageIndex(store);
  return { slug: page.slug, sourceCount: page.sources.length, backlinked };
}

/** 把引用这些条目的页标成「需重煮」（条目被删 / 被取代时调用） */
export function markRecompose(store, ids) {
  const hit = pagesUsing(store, ids);
  for (const p of hit) {
    const next = { ...p, needs_recompose: true, updated: p.updated || now() };
    store.atomicWrite(pageFile(store, p.slug), renderPageFile(next));
  }
  if (hit.length) writePageIndex(store);
  return hit.map((p) => p.slug);
}

/** 注入用的一行：- [知识] 标题 —— description */
export function pageLine(page) {
  const desc = clip(String(page.description || firstSentence(page.body, 60)).replace(/\s+/g, ' '), 70);
  return `- [知识] ${page.title}${desc ? ` —— ${desc}` : ''}`;
}

export function pageLines(pages, { maxItems = 4, includeStale = false } = {}) {
  return (pages || [])
    .filter((p) => includeStale || p.needs_recompose !== true) // 需重煮的页不注入（宁缺勿错）
    .slice()
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
    .slice(0, maxItems)
    .map(pageLine);
}

/** pages/index.md：所有页的标题 + 一行摘要（地图类型落地为这个目录） */
export function writePageIndex(store) {
  const pages = listPages(store);
  const lines = ['# 专题目录', '', `共 ${pages.length} 页 · 更新于 ${today()}`, ''];
  for (const p of pages.sort((a, b) => String(b.updated).localeCompare(String(a.updated)))) {
    const bad = p.needs_recompose ? '（需重煮）' : '';
    lines.push(`- **${p.title}**（${p.slug}，${p.sources?.length || 0} 条来源）${bad}${p.description ? ` — ${clip(p.description, 60)}` : ''}`);
  }
  lines.push('');
  const dir = pagesDir(store);
  fs.mkdirSync(dir, { recursive: true });
  store.atomicWrite(path.join(dir, PAGE_INDEX), lines.join('\n'));
  return { pages: pages.length };
}

/** 反查：这页引用了哪些条目现在长什么样 */
export function pageSources(store, slug) {
  return (readPage(store, slug)?.sources || []).map((id) => store.byId(id)).filter(Boolean);
}

export function deletePageFile(store, slug) {
  try {
    fs.rmSync(pageFile(store, slug), { force: true });
    writePageIndex(store);
    return true;
  } catch {
    return false;
  }
}
