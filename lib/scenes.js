/**
 * L2 场景层：把一次「任务」写成 scenes/<date>-<slug>.md。
 *
 * 一个会话可能切出 0–n 段。场景不进注入，只作为知识页素材、面板可翻、技能草稿的原料。
 * 每个场景是一个独立 Markdown 文件，frontmatter 带 id/session/turns/project/sources，
 * 正文固定四段：目标 / 怎么做的 / 结果 / 留下的坑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { clip, now, today } from './util.js';

export const SCENES_DIR = 'scenes';
export const SCENE_INDEX = 'index.json';
export const SCENE_SECTIONS = [
  ['goal', '目标'],
  ['steps', '怎么做的'],
  ['result', '结果'],
  ['pitfalls', '留下的坑'],
];

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 文件名安全的 slug：中文保留，去掉路径与空白 */
export function slugOf(title, max = 24) {
  const raw = String(title || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\p{Script=Han}\w]+/gu, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  const s = raw || 'scene';
  return s.length > max ? s.slice(0, max).replace(/-+$/, '') : s;
}

/** 从「2026-10-26 18:10」这类时间里取 HHMM；取不到就用当前时间 */
function stampOf(when) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(when || ''));
  if (m) return pad(Number(m[1])) + m[2];
  const d = new Date();
  return pad(d.getHours()) + pad(d.getMinutes());
}

export function scenesDir(store) {
  const dir = store.dir(SCENES_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 场景 id：sc-<YYYYMMDD>-<HHMM> */
export function sceneId({ day, when, title }) {
  const d = String(day || today()).replace(/-/g, '');
  return `sc-${d}-${stampOf(when)}-${slugOf(title, 12)}`;
}

export function scenePath(store, id) {
  return path.join(scenesDir(store), `${id}.md`);
}

const fm = (scene, meta) => {
  const rows = [
    ['type', 'scene'],
    ['id', scene.id],
    ['title', scene.title],
    ['session', meta.session || ''],
    ['turns', Array.isArray(meta.turns) ? meta.turns.join('-') : ''],
    ['started', meta.started || ''],
    ['ended', meta.ended || ''],
    ['project', meta.project || ''],
    ['sources', Array.isArray(meta.sources) ? `[${meta.sources.join(', ')}]` : '[]'],
  ];
  // 4E-7 失效联动：来源条目被丢弃/彻底删掉后记在这里，面板显示黄点
  if (Array.isArray(meta.stale_sources) && meta.stale_sources.length) {
    rows.push(['stale_sources', `[${meta.stale_sources.join(', ')}]`]);
  }
  rows.push(['created', scene.created || meta.created || now()]);
  return rows.map(([k, v]) => `${k}: ${v}`).join('\n');
};

export function renderScene(scene, meta = {}) {
  const body = SCENE_SECTIONS.map(([key, label]) => {
    const v = scene[key];
    const lines = Array.isArray(v) ? v.filter(Boolean).map((s) => `- ${s}`) : [];
    const text = lines.length ? lines.join('\n') : Array.isArray(v) ? '' : String(v || '').trim();
    return `## ${label}\n\n${text || '（没有）'}\n`;
  }).join('\n');
  return `---\n${fm(scene, meta)}\n---\n\n# ${scene.title}\n\n${body}`;
}

/** 读一个场景文件，解析回对象（够用即可：只认我们自己写的格式） */
export function readScene(store, id) {
  const file = scenePath(store, id);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const head = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([a-z_]+):\s*(.*)$/i.exec(line);
      if (kv) head[kv[1]] = kv[2];
    }
  }
  const body = m ? m[2] : text;
  const pick = (label) => {
    const re = new RegExp(`## ${label}\\r?\\n\\r?\\n([\\s\\S]*?)(?:\\r?\\n## |$)`);
    const hit = re.exec(body);
    const raw = hit ? hit[1].trim() : '';
    return raw === '（没有）' ? '' : raw;
  };
  const list = (label) =>
    pick(label)
      .split(/\r?\n/)
      .map((s) => s.replace(/^-\s*/, '').trim())
      .filter(Boolean);
  const turns = String(head.turns || '').split('-').map((n) => Number(n)).filter((n) => Number.isFinite(n));
  return {
    id: head.id || id,
    title: head.title || id,
    session: head.session || '',
    turns: turns.length === 2 ? turns : null,
    started: head.started || '',
    ended: head.ended || '',
    project: head.project || '',
    sources: String(head.sources || '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean),
    stale_sources: String(head.stale_sources || '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean),
    goal: pick('目标'),
    steps: list('怎么做的'),
    result: pick('结果'),
    pitfalls: list('留下的坑'),
    file: `${SCENES_DIR}/${id}.md`,
    created: head.created || '',
  };
}

export function listScenes(store) {
  const dir = scenesDir(store);
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const scene = readScene(store, name.slice(0, -3));
    if (scene) out.push(scene);
  }
  out.sort((a, b) => String(b.created || b.started).localeCompare(String(a.created || a.started)));
  return out;
}

/** 写场景文件；同 id 覆盖（重煮场景时用） */
export function writeScene(store, scene, meta = {}) {
  const id = scene.id || sceneId({ day: meta.day, when: meta.started, title: scene.title });
  const full = {
    id,
    title: clip(scene.title, 60) || '未命名场景',
    goal: clip(scene.goal, 400),
    steps: (Array.isArray(scene.steps) ? scene.steps : []).map((s) => clip(s, 200)).filter(Boolean).slice(0, 12),
    result: clip(scene.result, 400),
    pitfalls: (Array.isArray(scene.pitfalls) ? scene.pitfalls : []).map((s) => clip(s, 200)).filter(Boolean).slice(0, 8),
  };
  const text = renderScene(full, meta);
  const file = scenePath(store, id);
  fs.writeFileSync(file, text, 'utf8');
  writeSceneIndex(store);
  return { id, file: `${SCENES_DIR}/${id}.md`, title: full.title };
}

/** scenes/index.json：面板与知识页都要用它列场景，避免每次扫目录 */
export function writeSceneIndex(store) {
  const scenes = listScenes(store).map((s) => ({
    id: s.id,
    title: s.title,
    session: s.session,
    turns: s.turns,
    started: s.started,
    ended: s.ended,
    project: s.project,
    sources: s.sources,
    goal: s.goal,
    file: s.file,
    created: s.created,
  }));
  const data = { version: 1, built_at: now(), scenes };
  const file = path.join(scenesDir(store), SCENE_INDEX);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

export function readSceneIndex(store) {
  const file = path.join(scenesDir(store), SCENE_INDEX);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && Array.isArray(data.scenes)) return data;
  } catch {
    /* 坏文件或不存在 */
  }
  return writeSceneIndex(store);
}

export function deleteScene(store, id) {
  const file = scenePath(store, id);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  writeSceneIndex(store);
  return true;
}

/** 判断某个条目被哪些场景引用（删条目时提示「相关场景需重煮」） */
export function scenesUsing(store, entryId) {
  const id = String(entryId || '');
  return readSceneIndex(store).scenes.filter((s) => Array.isArray(s.sources) && s.sources.includes(id));
}

/** 4E-7：某几条记忆被丢弃/删掉 → 引用它们的场景打上 stale_sources（面板黄点） */
export function markScenesStale(store, ids = []) {
  const set = new Set((ids || []).map(String).filter(Boolean));
  if (!set.size) return [];
  const touched = [];
  for (const s of listScenes(store)) {
    const hit = (s.sources || []).filter((id) => set.has(String(id)));
    if (!hit.length) continue;
    const next = Array.from(new Set([...(s.stale_sources || []), ...hit]));
    if (next.length === (s.stale_sources || []).length) continue;
    const meta = {
      session: s.session,
      turns: s.turns,
      started: s.started,
      ended: s.ended,
      project: s.project,
      sources: s.sources,
      stale_sources: next,
      created: s.created,
    };
    fs.writeFileSync(scenePath(store, s.id), renderScene(s, meta), 'utf8');
    touched.push(s.id);
  }
  if (touched.length) writeSceneIndex(store);
  return touched;
}

/** 4E-7：清掉 stale 标记（重新生成/重煮时用） */
export function clearScenesStale(store, ids = []) {
  const set = new Set((ids || []).map(String).filter(Boolean));
  if (!set.size) return [];
  const touched = [];
  for (const s of listScenes(store)) {
    if (!(s.stale_sources || []).length) continue;
    if (!set.has(s.id) && !(s.sources || []).some((id) => set.has(String(id)))) continue;
    const meta = {
      session: s.session,
      turns: s.turns,
      started: s.started,
      ended: s.ended,
      project: s.project,
      sources: s.sources,
      stale_sources: [],
      created: s.created,
    };
    fs.writeFileSync(scenePath(store, s.id), renderScene(s, meta), 'utf8');
    touched.push(s.id);
  }
  if (touched.length) writeSceneIndex(store);
  return touched;
}
