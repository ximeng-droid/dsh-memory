/* store.js —— 文件仓库：读、写、原子写、journal、_trash、容器文件
   设计原则（来自策划书 §4/§7）：
   · 全部是 markdown，没有数据库；损坏可以直接打开看
   · 写文件一律「先写 .tmp 再 rename」，断电不会留半截
   · 删除只搬到 _trash\，改正文先把旧版存 _trash\历史\
   · profile.md 与 projects\*.md 是「容器文件」，一个文件里放多条（用 <!-- id --> 分隔）
   · inbox\*.md 是一条一个文件（待确认的候选） */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse, serialize, padId, safeName, now, today, clip } from './util.js';

export const DEFAULTS_DIRS = [
  'projects', 'inbox', 'daily', '_journal', '_trash', '_trash\\历史', '_archive',
];

const CONTAINER_MARK = /^<!--\s*([0-9]{4})\s*-->\s*$/;

/** 解析容器文件 → entries[] */
export function parseContainer(text) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const chunks = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(CONTAINER_MARK);
    if (m) {
      if (cur) chunks.push(cur);
      cur = { id: m[1], lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) chunks.push(cur);
  const out = [];
  for (const c of chunks) {
    const e = parse(c.lines.join('\n'));
    if (!e || !e.id) continue;
    out.push({ ...e, id: padId(e.id), body: e.body || '' });
  }
  return out;
}

/** entries[] → 容器文件文本 */
export function renderContainer(entries, header = '') {
  const parts = [];
  if (header) parts.push(header.trim(), '');
  for (const e of entries) {
    parts.push(`<!-- ${e.id} -->`, serialize(e).trim(), '');
  }
  return `${parts.join('\n').trim()}\n`;
}

export function createStore(options = {}) {
  const root = options.root || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'memory');
  const dir = (name) => path.join(root, name);

  /* ---------- 基础 ---------- */

  function ensure() {
    fs.mkdirSync(root, { recursive: true });
    for (const d of DEFAULTS_DIRS) fs.mkdirSync(path.join(root, d), { recursive: true });
    if (!fs.existsSync(path.join(root, 'profile.md'))) {
      fs.writeFileSync(path.join(root, 'profile.md'),
        '# profile.md —— 全局偏好与禁令（个人原则）\n\n<!-- 这里放「以后都…」「别再…」这类原则，永远是注入的前两条 -->\n', 'utf8');
    }
  }

  /** 原子写：同目录 .tmp → rename */
  function atomicWrite(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  }

  function readText(file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  /* ---------- 编号 ---------- */

  function maxId() {
    let max = 0;
    for (const e of all()) {
      const n = Number(e.id);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
  }

  function nextId() {
    return padId(maxId() + 1);
  }

  /* ---------- 读取 ---------- */

  /** 容器文件：profile.md + projects\*.md（含 _global.md） */
  function containers() {
    const list = [];
    const prof = path.join(root, 'profile.md');
    if (fs.existsSync(prof)) list.push({ file: prof, kind: 'profile' });
    const pd = dir('projects');
    if (fs.existsSync(pd)) {
      for (const f of fs.readdirSync(pd)) {
        if (f.toLowerCase().endsWith('.md') && !f.startsWith('.')) {
          list.push({ file: path.join(pd, f), kind: 'project' });
        }
      }
    }
    return list;
  }

  /** inbox 里一条一个文件 */
  function inboxFiles() {
    const d = dir('inbox');
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d)
      .filter((f) => f.toLowerCase().endsWith('.md') && !f.startsWith('.'))
      .map((f) => path.join(d, f));
  }

  function all() {
    const out = [];
    for (const c of containers()) {
      const t = readText(c.file);
      if (!t) continue;
      for (const e of parseContainer(t)) out.push({ ...e, file: c.file, container: c.kind });
    }
    for (const f of inboxFiles()) {
      const t = readText(f);
      if (!t) continue;
      const e = parse(t);
      if (!e || !e.id) continue;
      out.push({ ...e, id: padId(e.id), file: f, container: 'inbox' });
    }
    out.sort((a, b) => Number(a.id) - Number(b.id));
    return out;
  }

  function byId(id) {
    const want = padId(String(id).replace(/^#/, ''));
    return all().find((e) => e.id === want) || null;
  }

  function byStatus(status) {
    return all().filter((e) => (e.status || 'active') === status);
  }

  /* ---------- 写入 ---------- */

  /** 判定一条记忆应该落到哪个文件 */
  function targetOf(entry) {
    if (entry.status === 'pending') {
      return path.join(dir('inbox'), `${entry.id}-${safeName(entry.title || 'entry')}.md`);
    }
    const type = entry.type || 'fact';
    if (type === 'preference' || type === 'forbidden' || type === 'profile') {
      return path.join(root, 'profile.md');
    }
    const scopes = Array.isArray(entry.scope) ? entry.scope : [entry.scope].filter(Boolean);
    const proj = scopes.map((s) => String(s)).find((s) => s.startsWith('project:')) || '';
    const name = proj ? projectFileName(proj.slice('project:'.length)) : '_global';
    return path.join(dir('projects'), `${name}.md`);
  }

  /** 项目笔记的文件名：取路径最后一段，读起来比 Dworkdemo 顺眼 */
  function projectFileName(p) {
    const seg = String(p).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || 'project';
    return safeName(seg, 60) || 'project';
  }

  /** 容器文件的表头（首次创建时写） */
  function headerOf(file) {
    if (path.basename(file) === 'profile.md') return '# profile.md —— 全局偏好与禁令（个人原则）';
    const name = path.basename(file, '.md');
    return name === '_global' ? '# _global.md —— 全局事实与经验' : `# ${name}.md —— 项目笔记`;
  }

  /** 写一条（新建或覆盖同 id） */
  function put(entry, meta = {}) {
    const withMeta = {
      priority: 'normal',
      hits: 0,
      ...entry,
      updated: entry.updated || now(),
      created: entry.created || now(),
    };
    const target = targetOf(withMeta);

    if (withMeta.status === 'pending') {
      atomicWrite(target, serialize(withMeta));
      log(meta, `写入待确认 ${withMeta.id} → ${path.relative(root, target)}`);
      return { ...withMeta, file: target };
    }

    // 容器：读出来、替换或追加、整体写回
    const t = readText(target) || '';
    const list = parseContainer(t);
    const i = list.findIndex((e) => e.id === withMeta.id);
    if (i >= 0) list[i] = withMeta;
    else list.push(withMeta);
    atomicWrite(target, renderContainer(list, headerOf(target)));
    log(meta, `写入 ${withMeta.id} → ${path.relative(root, target)}`);
    return { ...withMeta, file: target };
  }

  /** 从原文件里摘掉一条（换文件时用） */
  function removeFrom(file, id) {
    const t = readText(file);
    if (!t) return;
    if (path.basename(path.dirname(file)) === 'inbox') {
      fs.rmSync(file, { force: true });
      return;
    }
    const list = parseContainer(t).filter((e) => e.id !== padId(id));
    atomicWrite(file, renderContainer(list, headerOf(file)));
  }

  /** 移动条目到新状态：先摘旧位置，再写到新位置 */
  function move(entry, patch, meta = {}) {
    const prev = byId(entry.id);
    const next = { ...(prev || entry), ...patch, id: padId(entry.id) };
    if (prev && prev.file) removeFrom(prev.file, prev.id);
    return put(next, meta);
  }

  /** 落历史版本（改正文前调用） */
  function saveHistory(id, oldText) {
    const f = path.join(dir('_trash\\历史'), `${padId(id)}-${Date.now()}.md`);
    atomicWrite(f, oldText);
    return f;
  }

  /** 删除 → _trash\（可捞回） */
  function trash(entry, reason = 'manual') {
    const prev = byId(entry.id);
    if (!prev) return null;
    const dest = path.join(dir('_trash'), `${prev.id}-${safeName(prev.title || 'entry')}-${Date.now()}.md`);
    if (path.basename(path.dirname(prev.file)) === 'inbox') {
      atomicWrite(dest, readText(prev.file) || '');
      fs.rmSync(prev.file, { force: true });
    } else {
      atomicWrite(dest, serialize(prev));
      removeFrom(prev.file, prev.id);
    }
    log({ reason }, `删除 ${prev.id}（${reason}）→ _trash`);
    return dest;
  }

  /** 从 _trash\ 捞回：编号被占用时换新号，避免两条同号 */
  function untrash(rel) {
    const full = resolveInside(rel);
    if (path.basename(path.dirname(full)) !== '_trash') throw new Error('只能从垃圾桶里捞回');
    const e = parse(readText(full) || '');
    if (!e || !e.title) throw new Error('这个垃圾桶文件读不出来');
    const next = { ...e, status: 'active', updated: now() };
    if (!next.id || byId(next.id)) next.id = nextId();
    const saved = put(next, { trigger: 'restore' });
    fs.rmSync(full, { force: true });
    log({ reason: 'restore' }, `捞回 ${saved.id}`);
    return saved;
  }

  /** 彻底删除（只在垃圾桶里用） */
  function purge(rel) {
    const full = resolveInside(rel);
    if (path.basename(path.dirname(full)) !== '_trash') throw new Error('只能删垃圾桶里的文件');
    fs.rmSync(full, { force: true });
    log({ reason: 'purge' }, `彻底删除 ${path.basename(full)}`);
    return true;
  }

  /** 只允许动 root 里面的相对路径（面板传进来的 file 字段） */
  function resolveInside(rel) {
    const rootAbs = path.resolve(root);
    const full = path.resolve(rootAbs, String(rel || ''));
    if (!full.startsWith(rootAbs + path.sep)) throw new Error('路径不在记忆库里');
    return full;
  }

  /* ---------- journal / daily ---------- */

  function log(meta, text) {
    const line = `- ${now()} · ${meta && meta.trigger ? meta.trigger : '插件'} · ${text}`;
    const f = path.join(dir('_journal'), `${today()}.md`);
    const head = fs.existsSync(f) ? '' : `# _journal ${today()}\n\n`;
    fs.appendFileSync(f, `${head}${line}\n`, 'utf8');
  }

  function appendDaily(lines) {
    const arr = Array.isArray(lines) ? lines : [lines];
    if (!arr.length) return;
    const f = path.join(dir('daily'), `${today()}.md`);
    const head = fs.existsSync(f) ? '' : `# ${today()} 日记\n\n`;
    const body = arr.map((l) => String(l).replace(/\r?\n/g, ' ').trim()).filter(Boolean)
      .map((l) => `- ${now().slice(11)} ${l}`).join('\n');
    if (!body) return;
    fs.appendFileSync(f, `${head}${body}\n`, 'utf8');
  }

  function readDaily(date = today()) {
    return readText(path.join(dir('daily'), `${date}.md`)) || '';
  }

  function journal(date = today()) {
    return readText(path.join(dir('_journal'), `${date}.md`)) || '';
  }

  /* ---------- 索引 ---------- */

  function indexPath() {
    return path.join(root, 'index.json');
  }

  function readIndex() {
    const t = readText(indexPath());
    if (!t) return null;
    try {
      const j = JSON.parse(t);
      if (!j || j.version !== 1 || !Array.isArray(j.docs)) return null;
      return j;
    } catch {
      return null;
    }
  }

  function writeIndex(index) {
    atomicWrite(indexPath(), `${JSON.stringify(index, null, 2)}\n`);
  }

  /* ---------- 统计 ---------- */

  function stats() {
    const list = all();
    const count = (s) => list.filter((e) => (e.status || 'active') === s).length;
    return {
      root,
      total: list.length,
      pending: count('pending'),
      active: count('active'),
      stale: count('stale'),
      conflict: count('conflict'),
      superseded: count('superseded'),
      archived: count('archived'),
      today: (readDaily().match(/^- /gm) || []).length,
      maxId: maxId(),
    };
  }

  return {
    root,
    dir,
    ensure,
    atomicWrite,
    readText,
    all,
    byId,
    byStatus,
    nextId,
    put,
    move,
    saveHistory,
    trash,
    untrash,
    purge,
    removeFrom,
    log,
    appendDaily,
    readDaily,
    journal,
    readIndex,
    writeIndex,
    stats,
    targetOf,
    // 导出给测试用
    _internal: { parseContainer, renderContainer, clip },
  };
}

export default createStore;
