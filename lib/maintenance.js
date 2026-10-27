/* 维护任务（阶段 3）：过期标记、日记蒸馏、自动写入可撤。
   全部是确定的文件操作，不调模型；判据都在这里，改阈值只动这一个文件。 */
import fs from 'node:fs';
import path from 'node:path';

import { now, today, isPinned } from './util.js';

/** 90 天没被检索过、又没置顶的生效条目 → stale（不删，注入降权）。 */
export function markStale(store, { days = 90, limit = 200 } = {}) {
  const cutoff = Date.now() - days * 86400000;
  const marked = [];
  for (const e of store.all()) {
    if (marked.length >= limit) break;
    if (e.status !== 'active') continue;
    if (isPinned(e.priority)) continue;   // 置顶的永不判过期
    const stamp = Date.parse(String(e.last_used || e.updated || e.created || '').replace(' ', 'T'));
    if (!Number.isFinite(stamp) || stamp > cutoff) continue;
    store.move(e, { status: 'stale', updated: now() }, { trigger: 'maintain' });
    marked.push(String(e.id));
  }
  return marked;
}

const NOISE = /^(好的|OK|嗯|收到|继续|谢谢|Time sampled)/i;

/** 把某天的流水压成几行摘要（去掉时间戳、去重、去寒暄）。 */
export function summarizeDaily(text, { maxLines = 40, maxChars = 1200 } = {}) {
  const seen = new Set();
  // 系统事件行（写入/注入/重建索引/维护）不算内容，否则日记摘录里全是噪音。
  // 日记真实前缀有两种：`12:34 · …`（旧）与 `2026-10-26T20:52 · …`（ISO，现用）⇒ 先剥时间戳再判。
  const STAMP = /^(?:\d{4}-\d{2}-\d{2}[T ])?\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?\s*(?:·\s*)?/;
  const EVENT = /^(plugin|inject|distill|scan|maintain|vector|page|scene|skill|history|suggest)\b\s*·/i;
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*-\s*/, '').replace(STAMP, '').replace(/^\s*·\s*/, '').trim();
    if (!line || line.startsWith('#') || NOISE.test(line) || EVENT.test(line)) continue;
    const key = line.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`- ${line}`);
    if (out.length >= maxLines) break;
  }
  let body = out.join('\n');
  if (body.length > maxChars) body = `${body.slice(0, maxChars)}…`;
  return body;
}

/** 把超过 days 天的 daily 蒸馏成一条 knowledge，原文件移进 _archive。 */
export function distillDailies(store, { days = 30, limit = 30 } = {}) {
  const dir = store.dir ? store.dir('daily') : path.join(store.root, 'daily');
  if (!fs.existsSync(dir)) return [];
  const cutoff = Date.now() - days * 86400000;
  const done = [];
  for (const name of fs.readdirSync(dir)) {
    if (done.length >= limit) break;
    const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name);
    if (!m) continue;
    const date = m[1];
    const stamp = Date.parse(`${date}T00:00:00`);
    if (!Number.isFinite(stamp) || stamp > cutoff) continue;
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, 'utf8');
    const body = summarizeDaily(text);
    if (!body) { moveToArchive(store, file, name); done.push({ date, id: '', lines: 0 }); continue; }
    const id = store.nextId();
    const saved = store.put({
      id, type: 'knowledge', status: 'active', scope: ['global'],
      title: `${date} 流水摘录`.slice(0, 40),
      body: body.slice(0, 300),
      priority: 'normal', created: now(), updated: now(),
      source: 'distill', source_trust: 'confirmed',
      tags: ['蒸馏'], rules: ['30 天蒸馏'], why: `daily\\${name} 超过 30 天`,
    }, { trigger: 'maintain' });
    moveToArchive(store, file, name);
    done.push({ date, id: String(saved.id), lines: (body.match(/^- /gm) || []).length });
  }
  return done;
}

function moveToArchive(store, file, name) {
  const archive = store.dir ? store.dir('_archive') : path.join(store.root, '_archive');
  fs.mkdirSync(archive, { recursive: true });
  const dest = path.join(archive, `daily-${name}`);
  fs.renameSync(file, dest);
}

/* ---------- 4B：日记归档阈值（腾讯的 auto-archive）
   日记是流水，一天不封顶就会长成 60 KB 那种东西。
   超过行数或字节阈值 ⇒ 蒸馏成一条摘录、整份进 _archive、再开一份空的。 */

export function autoArchiveJournal(store, { maxLines = 400, maxBytes = 32768, force = false } = {}) {
  const date = today();
  const journalDir = store.dir ? store.dir('_journal') : path.join(store.root, '_journal');
  const file = path.join(journalDir, `${date}.md`);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).length;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (!force && lines <= maxLines && bytes <= maxBytes) return null;
  if (!text.trim()) return null;

  const body = summarizeDaily(text);
  // 4E-7：整篇都是系统事件（没有一句人话）就别归档 —— 否则 _archive 里全是空壳，
  // 也不会产出条目。等真有内容再搬。
  if (!body && !force) return null;
  let id = '';
  if (body) {
    const saved = store.put({
      id: store.nextId(),
      type: 'knowledge', status: 'active', scope: ['global'],
      title: `${date} 流水摘录`.slice(0, 40),
      body: body.slice(0, 300),
      priority: 'normal', created: now(), updated: now(),
      source: 'distill', source_trust: 'confirmed',
      tags: ['蒸馏', '归档'], rules: ['日记归档'],
      why: `_journal\\${date}.md ${lines} 行 / ${bytes} 字节，超过阈值`,
    }, { trigger: 'maintain' });
    id = String(saved.id);
  }
  const archive = store.dir ? store.dir('_archive') : path.join(store.root, '_archive');
  fs.mkdirSync(archive, { recursive: true });
  const hhmm = new Date().toTimeString().slice(0, 5).replace(':', '');
  const dest = path.join(archive, `journal-${date}-${hhmm}.md`);
  fs.renameSync(file, dest);
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(file, '', 'utf8');
  return { date, id, lines, bytes, archive: path.basename(dest) };
}

/* ---------- auto 模式：记一笔「自动写入了什么」，好撤回 ---------- */

function autoLogPath(store) { return path.join(store.root, '.auto-log.json'); }

export function readAutoLog(store) {
  try { return JSON.parse(fs.readFileSync(autoLogPath(store), 'utf8')); } catch { return { entries: [] }; }
}

export function recordAuto(store, written, mode = 'auto') {
  if (!Array.isArray(written) || !written.length) return;
  const log = readAutoLog(store);
  const stamp = now();
  for (const w of written) {
    if (!w || !w.id) continue;
    log.entries.push({ id: String(w.id), kind: w.kind || 'new', title: w.title || '', at: stamp, mode });
  }
  // 只留最近 200 条，别让它无限长
  log.entries = log.entries.slice(-200);
  try {
    const tmp = `${autoLogPath(store)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, autoLogPath(store));
  } catch { /* 记不下来也不影响写入本身 */ }
}

/** 撤回最近 n 条自动写入（进垃圾桶，可捞回）。 */
export function undoAuto(store, n = 1) {
  const log = readAutoLog(store);
  const taken = [];
  while (taken.length < n && log.entries.length) {
    const it = log.entries.pop();
    const e = store.byId(it.id);
    if (!e) continue;                       // 早就被删了
    if (e.status !== 'active') continue;    // 只有真的生效的才撤
    store.trash(e, 'undo');
    taken.push({ id: String(e.id), title: e.title || it.title });
  }
  try {
    fs.writeFileSync(autoLogPath(store), `${JSON.stringify(log, null, 2)}\n`, 'utf8');
  } catch { /* 忽略 */ }
  return taken;
}

export function maintenanceReport({ stale = [], distilled = [] } = {}) {
  const bits = [];
  if (stale.length) bits.push(`标过期 ${stale.length} 条`);
  if (distilled.length) bits.push(`蒸馏 ${distilled.length} 天的日记`);
  return bits.length ? bits.join('，') : '没有需要处理的';
}

export { today };
