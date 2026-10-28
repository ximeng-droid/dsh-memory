/* 服务层：把 store / rules / dedupe / search / inject 拼成一个对外的窄接口。
   面板只认这里的 list/accept/discard/…，插件外壳只认 capture/retrieve/injection，
   两边都不直接摸文件和索引，换实现只动这一个文件。 */
import fs from 'node:fs';
import path from 'node:path';

import { createStore } from './store.js';
import { extract } from './rules.js';
import { check as guardCheck } from './guard.js';
import { compare, merged } from './dedupe.js';
import { buildIndex, search as searchIndex, ensureIndex } from './search.js';
import { buildInjection, select } from './inject.js';
import { autoArchiveJournal, distillDailies, markStale, markVolatile, maintenanceReport, readAutoLog, recordAuto, undoAuto } from './maintenance.js';
import { loadConfig, saveConfig, defaultRoot } from './config.js';
import { readPersona, renderPersona, renderPersonaBlock, writePersona, personaEmpty } from './persona.js';
import { acceptSuggestion as acceptSug, dismissSuggestion as dismissSug, readSuggestions, refreshSuggestions } from './suggest.js';
import { composePage, listPages, markRecompose, pageLines, pageSources, readPage, savePage, slugOf } from './pages.js';
import { listSessions } from './sessions.js';
import { deleteScene, listScenes, markScenesStale, readScene, sceneId, writeScene, writeSceneIndex } from './scenes.js';
import { deleteSkill, listSkills, readSkill, skillLines, skillsForScope, writeSkill, writeSkillIndex } from './skills.js';
import { describeScope, ensureProject, findById, nextProjectId, pathInProject, readProjects, toEntityScopes, writeProjects } from './projects.js';
import { cosine, createEmbedder, describeVectors, ensureVectors, readVectors } from './vector.js';
import { isPinned, now, normalizePriority, padId, parse, similarity, today, tokenize } from './util.js';

const LIVE = new Set(['active', 'stale', 'pending', 'superseded', 'conflict']);

/** 面板能改的类型（跟 rules.js 抽出来的保持一套词） */
const TYPES = ['preference', 'forbidden', 'decision', 'experience', 'fact', 'project', 'knowledge', 'profile'];

/** 面板传上来的范围：'global' / 'project:<路径>' / 数组，统一成 ['global'] 或 ['project:…'] */
function normalizeScope(scope) {
  if (Array.isArray(scope)) {
    const arr = scope.map((x) => String(x || '').trim()).filter(Boolean);
    return arr.length ? arr : null;
  }
  if (typeof scope !== 'string') return null;
  const s = scope.trim();
  if (!s) return null;
  if (s === 'global') return ['global'];
  if (s.startsWith('project:')) return [s];
  return ['project:' + s];
}

const DUPE_SENT_STOP = /[。！？!?；;\n]/

function firstSentence(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  const m = s.split(DUPE_SENT_STOP)[0] || s
  return m.trim().slice(0, 80)
}

function topicOf(entry) {
  return `${String(entry?.title || '')} ${firstSentence(entry?.body)}`.trim()
}

function kwSet(text) {
  const out = new Set()
  for (const w of tokenize(String(text || ''))) if (String(w).length >= 2) out.add(String(w))
  return out
}

function sharedKeywords(a, b) {
  const A = kwSet(a)
  const B = kwSet(b)
  let n = 0
  for (const w of A) if (B.has(w)) n += 1
  return n
}

function scopeKey(scopes) {
  const list = Array.isArray(scopes) ? scopes : scopes ? [scopes] : []
  return list.map((s) => String(s)).sort().join('|')
}

/** 判重的第二条件：光分数像不算，还得同类型 / 共享 ≥2 个关键词 / 同范围 */
export function dupeVerdict(probe, entry) {
  if (!entry) return { dup: false, why: 'no-hit' }
  const kw = sharedKeywords(probe.text, topicOf(entry))
  const sameType = probe.type && String(entry.type || '') === String(probe.type)
  const sameScope = scopeKey(probe.scope) === scopeKey(entry.scope)
  const dup = Boolean(sameType) || kw >= 2 || sameScope
  const why = sameType ? '同类型' : kw >= 2 ? `共享 ${kw} 个关键词` : sameScope ? '同范围' : '只有分数像'
  return { dup, why, kw }
}

export function createService({ root, trigger = 'service', pointer = true } = {}) {
  let store = createStore({ root });
  store.ensure();
  const log = (text) => { try { store.log({ trigger }, text); } catch { /* 日志失败不影响主流程 */ } };

  let lastDiag = {}
  const fileOf = (e) => (e && e.file ? path.relative(store.root, e.file) : '');
  const whyOf = (e) => e.why || (Array.isArray(e.rules) ? e.rules.join(' · ') : '') || '';

  /* ---------- 读 ---------- */

  function counts() {
    const list = store.all();
    const byType = {};
    for (const e of list) {
      const s = e.status || 'active';
      if (s === 'archived' || s === 'rejected') continue;
      byType[e.type || 'fact'] = (byType[e.type || 'fact'] || 0) + 1;
    }
    const trashDir = store.dir('_trash');
    let trash = 0;
    try { trash = fs.readdirSync(trashDir).filter((f) => f.endsWith('.md')).length; } catch { trash = 0; }
    return {
      pending: list.filter((e) => (e.status || 'active') === 'pending').length,
      all: list.filter((e) => LIVE.has(e.status || 'active')).length,
      byType,
      trash,
      today: today(),
    };
  }

  function shape(e) {
    return {
      id: padId(e.id),
      type: e.type || 'fact',
      title: e.title || '',
      body: e.body || '',
      why: whyOf(e),
      rules: Array.isArray(e.rules) ? e.rules : [],
      scope: Array.isArray(e.scope) ? e.scope : e.scope ? [e.scope] : ['global'],
      tags: Array.isArray(e.tags) ? e.tags : e.tags ? [e.tags] : [],
      status: e.status || 'active',
      priority: normalizePriority(e.priority) ?? 1,
      created: e.created || '',
      updated: e.updated || '',
      last_used: e.last_used || '',
      hits: Number(e.hits) || 0,
      file: fileOf(e),
      conflicts_with: e.conflicts_with || e.conflict_with || '',
      superseded_by: e.superseded_by || '',
      supersedes: e.supersedes || '',
      supersede_reason: e.supersede_reason || '',
      page: e.page || '',
      source: e.source || '',
      source_trust: e.source_trust || '',
      turn_ref: e.turn_ref || '',
      session: e.session || '',
    };
  }

  function trashEntries() {
    const dir = store.dir('_trash');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return []; }
    return files.map((f) => {
      const full = path.join(dir, f);
      let e = {};
      try { e = parse(store.readText(full) || '') || {}; } catch { e = {}; }
      const id = (f.match(/^(\d{3,})/) || [])[1] || '---';
      return shape({ id, status: 'rejected', ...e, file: full, title: e.title || f.replace(/\.md$/, '') });
    }).sort((a, b) => String(b.id).localeCompare(String(a.id)));
  }

  /**
   * 日记视图：今天到底发生了什么的**事实清单**（不调模型）。
   * 卡片一：今天的每个会话一行（标题 / 轮数 / 大小）
   * 卡片二：今天新落库的记忆
   * 卡片三：今天的系统动作（来自 _journal，只取最近 12 行）
   */
  function dailyCards() {
    const day = today();
    const cards = [];

    let sessions = [];
    try { sessions = listSessions(store).filter((s) => s.day === day); } catch { sessions = []; }
    if (sessions.length) {
      const rows = sessions
        .sort((a, b) => (Number(b.meta?.turns) || 0) - (Number(a.meta?.turns) || 0))
        .slice(0, 12)
        .map((s) => {
          const title = String(s.meta?.title || s.id).slice(0, 60);
          const turns = Number(s.meta?.turns) || 0;
          const kb = Math.max(1, Math.round((Number(s.meta?.bytes) || 0) / 1024));
          return `- ${title}（${turns} 轮 · ${kb} KB${s.hasRaw ? '' : ' · 只留摘要'}）`;
        });
      cards.push(shape({
        id: `daily-sessions-${day}`, type: 'experience', status: 'active',
        title: `今天聊了 ${sessions.length} 个会话`,
        body: rows.join('\n'),
        scope: ['global'], tags: ['日记', '会话'], file: path.posix.join('_sessions', day),
        created: `${day} 00:00`,
      }));
    }

    let todayEntries = [];
    try { todayEntries = store.all().filter((e) => String(e.created || '').startsWith(day)); } catch { todayEntries = []; }
    if (todayEntries.length) {
      const rows = todayEntries
        .sort((a, b) => String(b.id).localeCompare(String(a.id)))
        .slice(0, 20)
        .map((e) => `- [${e.type || 'fact'}] ${String(e.title || '').slice(0, 50)}（${padId(e.id)} · ${e.status || 'active'}）`);
      cards.push(shape({
        id: `daily-entries-${day}`, type: 'knowledge', status: 'active',
        title: `今天记下 ${todayEntries.length} 条`,
        body: rows.join('\n'),
        scope: ['global'], tags: ['日记', '记忆'], file: path.posix.join('projects', '_global.md'),
        created: `${day} 00:00`,
      }));
    }

    let sys = [];
    try { sys = (store.journal(day) || '').split('\n').filter((l) => l.startsWith('- ')); } catch { sys = []; }
    if (sys.length) {
      const rows = sys.slice(-12).map((l) => '- ' + l.replace(/^- (?:\d{4}-\d{2}-\d{2}T)?\d{1,2}:\d{2}(?::\d{2})?\s*·\s*/, ''));
      cards.push(shape({
        id: `daily-sys-${day}`, type: 'experience', status: 'active',
        title: `系统动作 ${sys.length} 条`,
        body: rows.join('\n'),
        scope: ['global'], tags: ['日记', '系统'], file: path.posix.join('_journal', `${day}.md`),
        created: `${day} 00:00`,
      }));
    }

    if (!cards.length) {
      cards.push(shape({
        id: `daily-empty-${day}`, type: 'experience', status: 'active',
        title: '今天还没有记录',
        body: '这一天还没有会话、没有新记忆、也没有系统动作。',
        scope: ['global'], tags: ['日记'], file: path.posix.join('_journal', `${day}.md`),
        created: `${day} 00:00`,
      }));
    }
    return cards;
  }

  function list({ view = 'pending', q = '', limit = 300 } = {}) {
    const all = store.all();
    let entries;
    if (view === 'trash') entries = trashEntries();
    else if (view === 'daily') entries = dailyCards();
    else if (view === 'all') entries = all.filter((e) => LIVE.has(e.status || 'active')).map(shape);
    else if (view.startsWith('type:')) {
      const t = view.slice(5);
      entries = all.filter((e) => (e.type || 'fact') === t && LIVE.has(e.status || 'active')).map(shape);
    } else entries = all.filter((e) => (e.status || 'active') === 'pending').map(shape);

    if (q) {
      const idx = ensureIndex(store);
      const hits = new Set(searchIndex(idx, q, { includeInactive: true, limit: 200 }).map((h) => padId(h.id)));
      const low = q.toLowerCase();
      entries = entries.filter((e) => hits.has(e.id) || e.id.includes(low)
        || e.title.toLowerCase().includes(low) || e.body.toLowerCase().includes(low));
    }

    const order = { pending: 0, active: 1, stale: 2, superseded: 3 };
    entries.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)
      || String(b.created).localeCompare(String(a.created)));
    return {
      entries: entries.slice(0, limit),
      counts: counts(),
      meta: { entries: store.all().length, root: store.root },
    };
  }

  /* ---------- 写 ---------- */

  function accept(id) {
    const e = store.byId(id);
    if (!e) throw new Error(`没有这条记忆：${id}`);
    const next = store.move(e, { status: 'active' }, { trigger });
    log(`收下 ${padId(id)}`);
    return shape(next);
  }

  function discard(id) {
    const e = store.byId(id);
    if (!e) throw new Error(`没有这条记忆：${id}`);
    store.trash(e, 'panel');
    try { markRecompose(store, [e.id]); } catch { /* 页不存在就跳过 */ }
    try { markScenesStale(store, [e.id]); } catch { /* 没有场景就跳过 */ }
    log(`丢弃 ${padId(id)}`);
    return { id: padId(id) };
  }

  function edit(id, { title, body, type, scope, priority } = {}) {
    const e = store.byId(id);
    if (!e) throw new Error(`没有这条记忆：${id}`);
    if (e.file) store.saveHistory(e.id, store.readText(e.file) || '');
    const patch = { updated: now() };
    if (typeof title === 'string' && title.trim()) patch.title = title.trim().slice(0, 40);
    if (typeof body === 'string') patch.body = body.trim().slice(0, 300);   // 允许清空
    if (TYPES.includes(type)) patch.type = type;
    const sc = normalizeScope(scope);
    if (sc) patch.scope = sc;
    const pr = normalizePriority(priority);
    if (pr !== undefined) patch.priority = pr;
    const next = store.move(e, patch, { trigger });
    log(`手改 ${padId(id)}`);
    return shape(next);
  }

  /** 从垃圾桶捞回一条 */
  function restore(file) {
    const e = store.untrash(file);
    log(`捞回 ${padId(e.id)}`);
    return shape(e);
  }

  /** 垃圾桶里彻底删掉 */
  function purgeTrash(file) {
    const rel = String(file || '');
    const idMatch = /(?:^|[\\/])(\d{4,})-/.exec(rel);
    if (idMatch) { try { markScenesStale(store, [idMatch[1]]); } catch { /* 忽略 */ } }
    store.purge(file);
    log('彻底删除一条');
    return { ok: true };
  }

  function create({ title, body = '', type = 'fact', scope = ['global'], status = 'active', priority } = {}) {
    const t = String(title || '').trim();
    if (!t) throw new Error('标题不能为空');
    const g = guardCheck(`${t}\n${body}`);
    if (!g.ok) throw new Error(g.reject);
    const id = store.nextId();
    const cfg0 = loadConfig(store.root);
    const scopes = toEntityScopes(store, scope, { autoCreate: cfg0.projects?.autoCreate !== false });
    const e = {
      id, type, scope: scopes, status: g.forcePending ? 'pending' : status,
      title: t.slice(0, 40), body: String(body).trim().slice(0, 300),
      priority: normalizePriority(priority) ?? 1, created: now(), updated: now(),
      source: 'manual', source_trust: status === 'pending' ? 'inferred' : 'confirmed',
      tags: [], rules: ['手动记录'], why: '面板里手动新增',
    };
    const saved = store.put(e, { trigger });
    log(`手动新增 ${padId(id)}`);
    return shape(saved);
  }

  /* ---------- 抓取 ---------- */

  function capture({ user = '', assistant = '', cwd = '', source = 'session' } = {}) {
    const cfg = loadConfig(store.root);
    if (cfg.writeMode === 'manual') return { candidates: [], dropped: 0, written: [] };
    const { candidates, dropped } = extract({
      user, assistant: cfg.capture.fromAssistant ? assistant : '', cwd,
      source, minScore: cfg.capture.minScore,
    });
    const written = [];
    for (const c of candidates) {
      const g = guardCheck(`${c.title}\n${c.body}`);
      if (!g.ok) { dropped.push({ sentence: c.title, score: c.score, why: g.reject }); continue; }
      // 只跟同类型、非待确认的旧条目比；compare 收的是 (候选, 旧条目数组)
      const pool = store.all().filter((e) => (e.type || 'fact') === c.type
        && !['pending', 'rejected', 'archived'].includes(e.status || 'active'));
      const v = compare({ title: c.title, body: c.body, type: c.type }, pool, cfg.dedupe);
      const id = store.nextId();
      const candidate = {
        ...c, id, priority: 'normal', created: now(), updated: now(),
        scope: toEntityScopes(store, c.scope, { autoCreate: cfg.projects?.autoCreate !== false }),
        source, source_trust: 'session', status: 'pending',
        why: (c.rules || []).join(' · '),
      };
      if (v.action === 'merge' && v.match) {
        const m = merged(v.match, candidate, now());
        const saved = store.move(v.match, m, { trigger });
        written.push({ kind: 'merge', id: saved.id, title: saved.title });
        continue;
      }
      if (v.action === 'conflict' && v.match) {
        candidate.conflicts_with = padId(v.match.id);
        candidate.status = 'conflict';
        candidate.why = `${candidate.why}（与 ${padId(v.match.id)} 可能矛盾）`;
      }
      if (v.action === 'supersede' && v.match) {
        candidate.supersedes = padId(v.match.id);
        candidate.supersede_reason = v.reason || '数值更新';
        candidate.why = `${candidate.why}（顶掉 ${padId(v.match.id)}：${candidate.supersede_reason}）`;
      }
      if (cfg.writeMode === 'auto' && !g.forcePending && (v.action === 'new' || v.action === 'supersede')) {
        candidate.status = 'active';
        candidate.source_trust = 'confirmed';
      }
      const saved = store.put(candidate, { trigger });
      if (v.action === 'conflict' && v.match) {
        // 对面那条也标成冲突，面板两边都能看见、裁决任一方向都对得上
        store.move(v.match, { status: 'conflict', conflicts_with: padId(saved.id) }, { trigger });
      }
      if (v.action === 'supersede' && v.match) {
        // 更正链：旧条退位但留着可追溯
        store.move(v.match, {
          status: 'superseded',
          superseded_by: padId(saved.id),
          updated: now(),
        }, { trigger });
      }
      written.push({ kind: v.action, id: saved.id, title: saved.title });
    }
    if (written.length && cfg.writeMode === 'auto') recordAuto(store, written, 'auto');
    if (written.length) log(`抽到 ${written.length} 条（${written.map((w) => `${w.kind}:${w.id}`).join(', ')}）`);
    touchDiag('capture', { written: written.length, dropped: dropped.length });
    return { candidates, dropped: dropped.length, written };
  }

  /* ---------- 蒸馏产物落地（4E-2） ---------- */

  /**
   * 把蒸馏出来的条目写进库。走和 capture 同一套守卫/去重/更正链，
   * 状态按 writeMode：auto → active，semi → pending，manual → 不落。
   */
  /** 落地蒸馏出来的技能：skills/<slug>.md。semi 模式写成 status: pending（不注入）。 */
  function landSkills(items, { mode = 'auto', sessionId = '', project = '' } = {}) {
    const written = []
    if (!Array.isArray(items) || !items.length) return { written }
    const scopeOf = (s) => {
      if (String(s?.scope || '') === 'global') return ['global']
      const p = String(project || '').trim()
      return p ? [p.startsWith('project:') ? p : 'project:' + p] : ['global']
    }
    for (const it of items) {
      const title = String(it?.title || '').trim()
      if (title.length < 2) continue
      // 标题高度相似的旧技能视为同一张卡：复用旧 slug，避免每蒸一次多一份
      const twin = listSkills(store).find((x) => similarity(String(x.title || ''), title) >= 0.8)
      const saved = writeSkill(store, {
        slug: twin ? twin.slug : undefined,
        title,
        when: String(it?.when || ''),
        how: Array.isArray(it?.how) ? it.how : [],
        pitfalls: Array.isArray(it?.pitfalls) ? it.pitfalls : [],
        verify: String(it?.verify || ''),
        keywords: Array.isArray(it?.keywords) ? it.keywords : [],
        scope: scopeOf(it),
        status: mode === 'auto' ? 'active' : 'pending',
        source: sessionId ? '蒸馏 · ' + sessionId.slice(0, 16) : '蒸馏',
      })
      written.push(saved)
    }
    if (written.length) {
      const ids = written.map((w) => w.slug)
      recordAuto(store, ids.map((slug) => ({ kind: 'skill', id: slug, title: slug })), 'distill')
      touchDiag('skills', { written: written.length })
    }
    return { written }
  }

  /** 面板/命令用：技能清单（默认全部） */
  function skills({ project = '', globalOnly = false } = {}) {
    if (!project && !globalOnly) return listSkills(store)
    return skillsForScope(store, { project, global: true })
  }

  function skill(slug) {
    return readSkill(store, String(slug || ''))
  }

  function removeSkill(slug) {
    return { ok: deleteSkill(store, String(slug || '')), slug: String(slug || '') }
  }

  /** 落地蒸馏出来的场景：写成 scenes/<id>.md，不进注入。sources 用本次落地的条目 id。 */
  function landScenes(scenes, { sessionId = '', day = '', project = '', sources = [], started = '', ended = '' } = {}) {
    const written = []
    if (!Array.isArray(scenes) || !scenes.length) return { written }
    for (const sc of scenes) {
      const title = String(sc?.title || '').trim()
      if (title.length < 2) continue
      // 同一标题（忽略时间）视为同一个场景：复用旧 id，避免每蒸一次就多一份
      const base = slugOf(title, 12)
      const dup = listScenes(store).find((x) => slugOf(x.title, 12) === base)
      const id = dup ? dup.id : sceneId({ day, when: started, title })
      const turns = Array.isArray(sc?.turns) ? sc.turns : []
      const saved = writeScene(store, {
        id, title,
        goal: String(sc?.goal || ''),
        steps: Array.isArray(sc?.steps) ? sc.steps : [],
        result: String(sc?.result || ''),
        pitfalls: Array.isArray(sc?.pitfalls) ? sc.pitfalls : [],
      }, {
        session: sessionId,
        turns: turns.length === 2 ? turns : [],
        started: started || now(),
        ended: ended || now(),
        project,
        sources: sources.map((s) => padId(s)),
      })
      written.push(saved)
    }
    if (written.length) touchDiag('scenes', { written: written.length })
    return { written }
  }

  /** 面板用：所有场景（读索引，不扫目录） */
  function scenes() {
    const data = listScenes(store)
    return data.map((s) => ({
      id: s.id, title: s.title, session: s.session, turns: s.turns,
      started: s.started, ended: s.ended, project: s.project,
      sources: s.sources, stale_sources: s.stale_sources || [],
      stale: (s.stale_sources || []).length > 0,
      goal: s.goal, created: s.created, file: s.file,
    }))
  }

  function scene(id) {
    return readScene(store, String(id || ''))
  }

  function removeScene(id) {
    const ok = deleteScene(store, String(id || ''))
    return { ok, id }
  }

  /** 某条目被哪些场景引用（删条目前提示） */
  function scenesOf(entryId) {
    return scenesUsing(store, entryId)
  }

  function landDistilled(items, { mode = 'auto', sessionId = '', source = 'distill', turnRef = '', project = '' } = {}) {
    const cfg = loadConfig(store.root)
    const written = []
    const dropped = []
    if (mode === 'manual' || !Array.isArray(items) || !items.length) {
      return { written, dropped, skipped: true }
    }
    for (const it of items) {
      const type = TYPES.includes(it?.type) ? it.type : 'fact'
      const title = String(it?.title || '').trim().slice(0, 40)
      const body = String(it?.body || '').trim().slice(0, 300)
      if (title.length < 2 || body.length < 2) { dropped.push({ title, why: '字段不全' }); continue }
      const g = guardCheck(title + '\n' + body)
      if (!g.ok) { dropped.push({ title, why: g.reject }); continue }
      const pool = store.all().filter((e) => (e.type || 'fact') === type
        && !['pending', 'rejected', 'archived'].includes(e.status || 'active'))
      const v = compare({ title, body, type }, pool, cfg.dedupe)
      const id = store.nextId()
      const candidate = {
        id, type, title, body,
        why: String(it?.why || '会话蒸馏').slice(0, 120),
        scope: toEntityScopes(store, project ? ['project:' + project] : ['global'], { autoCreate: cfg.projects?.autoCreate !== false }),
        tags: source === 'turn' ? ['单轮'] : ['蒸馏'], priority: 'normal',
        created: now(), updated: now(), source, source_trust: 'distilled',
        status: 'pending',
      }
      if (sessionId) candidate.session = sessionId
      if (turnRef) candidate.turn_ref = String(turnRef).slice(0, 80)
      if (v.action === 'merge' && v.match) {
        const m = merged(v.match, candidate, now())
        const saved = store.move(v.match, m, { trigger })
        written.push({ kind: 'merge', id: saved.id, title: saved.title })
        continue
      }
      if (v.action === 'conflict' && v.match) {
        candidate.conflicts_with = padId(v.match.id)
        candidate.status = 'conflict'
      }
      if (v.action === 'supersede' && v.match) {
        candidate.supersedes = padId(v.match.id)
        candidate.supersede_reason = v.reason || '数值更新'
      }
      // 单轮抽取的落地策略（策划书 §25.5）：B=一律直接生效（默认）；A=只有高置信 + 偏好/禁忌才直接生效
      const policy = String(cfg.distill?.turnPolicy || 'B').toUpperCase()
      let allowActive = true
      if (source === 'turn' && policy === 'A') {
        allowActive = it?.confidence === 'high' && (type === 'preference' || type === 'forbidden')
      }
      if (mode === 'auto' && !g.forcePending && allowActive && (v.action === 'new' || v.action === 'supersede')) {
        candidate.status = 'active'
        candidate.source_trust = 'confirmed'
      }
      const saved = store.put(candidate, { trigger })
      if (v.action === 'conflict' && v.match) {
        store.move(v.match, { status: 'conflict', conflicts_with: padId(saved.id) }, { trigger })
      }
      if (v.action === 'supersede' && v.match) {
        store.move(v.match, { status: 'superseded', superseded_by: padId(saved.id), updated: now() }, { trigger })
      }
      written.push({ kind: v.action, id: saved.id, title: saved.title })
    }
    if (written.length && mode === 'auto') recordAuto(store, written, 'distill')
    if (written.length) reindex()
    touchDiag('distill', { written: written.length, dropped: dropped.length })
    return { written, dropped }
  }
  /* ---------- 检索 / 注入 ---------- */

  /**
   * 检索：BM25 打底，装了向量模型就做混合（alpha 见 config.vector.alpha）。
   * 向量这一侧任何失败都不影响结果 —— 退回纯 BM25。
   */
  async function retrieve(query, { cwd = '', limit = 5, includeInactive = false } = {}) {
    const idx = ensureIndex(store);
    const cfg = loadConfig(store.root);
    let queryVec = null;
    let vectors = null;
    if (vectorEnabled(cfg) && !vectorBroken) {
      try {
        const emb = getEmbedder(cfg);
        const entries = store.all();
        const built = await ensureVectors(store, entries, emb);
        vectors = Object.fromEntries(Object.entries(built.data.items).map(([id, it]) => [id, it.v]));
        const [qv] = await emb.embed([String(query ?? '')]);
        queryVec = qv || null;
      } catch (err) {
        // 模型不可用（没装、没下载、内存不够）：本次之后就不要再试，免得每次搜索都等超时
        vectorBroken = true;
        log('向量不可用，退回 BM25（本次会话不再尝试）：' + (err?.message || err));
        vectors = null;
        queryVec = null;
      }
    }
    return searchIndex(idx, query, {
      cwd, limit, includeInactive,
      projects: readProjects(store).projects,
      vectors, queryVec,
      alpha: Number(cfg.vector?.alpha ?? 0.6),
    })
      .map((h) => shape(store.byId(h.id) || {}))
      .filter((e) => e.title);
  }

  /* ---------- 向量（4D，策划书 §23.9） ---------- */

  let embedder = null;
  let embedderKey = '';
  let vectorBroken = false;

  function vectorEnabled(cfg) {
    const v = cfg.vector || {};
    return v.enabled !== false;
  }

  function getEmbedder(cfg) {
    const v = cfg.vector || {};
    // 模型缓存默认放库内 <root>/.models —— 跟着记忆库走，重装插件/清 node_modules 都不会丢
    const cacheDir = v.cacheDir || path.join(store.root, '.models');
    const key = [v.model, v.dtype, cacheDir].join('|');
    if (!embedder || embedderKey !== key) {
      embedder = createEmbedder({ model: v.model, dtype: v.dtype, cacheDir });
      embedderKey = key;
    }
    return embedder;
  }

  /** 面板/诊断用：当前向量状态（不触发加载模型） */
  function vectorStatus() {
    const cfg = loadConfig(store.root);
    const data = readVectors(store);
    return {
      enabled: vectorEnabled(cfg),
      model: data.model || cfg.vector?.model || '',
      dim: data.dim || 0,
      built: Object.keys(data.items || {}).length,
      total: store.all().length,
      text: describeVectors(data, { enabled: vectorEnabled(cfg) }),
    };
  }

  /** 手动补齐向量（首次开向量、或导入了一批条目） */
  async function embedAll({ limit = 200 } = {}) {
    const cfg = loadConfig(store.root);
    if (!vectorEnabled(cfg)) return { ok: false, reason: '向量检索已关闭' };
    // 手动「建一次」= 允许重新加载模型（之前失败过也再试）
    vectorBroken = false;
    embedder = null;
    try {
      const emb = getEmbedder(cfg);
      const r = await ensureVectors(store, store.all(), emb, { limit });
      return { ok: true, embedded: r.embedded, total: r.total };
    } catch (err) {
      return { ok: false, reason: err?.message || String(err) };
    }
  }

  function touch(ids) {
    for (const id of ids) {
      const e = store.byId(id);
      if (!e) continue;
      store.move(e, { hits: (Number(e.hits) || 0) + 1, last_used: now() }, { trigger: 'inject' });
    }
  }

  function injection({ cwd = '' } = {}) {
    const cfg = loadConfig(store.root);
    const all = store.all().map(shape);
    const persona = readPersona(store);
    const opts = {
      cwd,
      projects: readProjects(store).projects,
      maxItems: cfg.inject.maxItems,
      maxTokens: cfg.inject.maxTokens,
      includeMaps: cfg.inject.includeMaps,
      splitSections: cfg.inject.splitSections !== false,
      pageLines: cfg.pages?.inject === false
        ? []
        : pageLines(listPages(store), { maxItems: cfg.pages?.maxItems || 4 }),
      skillLines: cfg.skills?.inject === false
        ? []
        : skillLines(
          skillsForScope(store, {
            project: (() => {
              const p = readProjects(store).projects.find((x) => Array.isArray(x.paths) && x.paths.some((d) => pathInProject({ paths: [d] }, cwd)));
              return p ? 'project:' + p.id : '';
            })(),
            global: true,
          }),
          { maxItems: cfg.skills?.maxItems || 4 }
        ),
      personaText: cfg.inject.persona === false || personaEmpty(persona) ? '' : renderPersonaBlock(persona),
      pendingCount: all.filter((e) => e.status === 'pending').length,
      conflicts: (() => {
        const seen = new Set();
        const out = [];
        for (const e of all) {
          if (e.status !== 'conflict') continue;
          const other = String(e.conflicts_with || '?');
          const key = [e.id, other].sort().join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          out.push([e.id, other]);
        }
        return out;
      })(),
    };
    const picks = select(all, opts);
    const block = buildInjection(all, opts);
    touch(picks.map((p) => p.id));
    return { block, picks };
  }

  /* ---------- 维护 ---------- */

  function reindex() {
    const idx = buildIndex(store.all());
    store.writeIndex(idx);
    log(`重建索引：${idx.docs.length} 条`);
    touchDiag('reindex', { docs: idx.docs.length, built_at: idx.built_at });
    void embedAll().catch(() => {});
    return { docs: idx.docs.length, built_at: idx.built_at };
  }

  /* ---------- 更正链（4B） ---------- */

  /**
   * 手动取代：newId 顶掉 oldId。
   * 与「冲突裁决」区别：这里人已经知道谁新谁旧，不需要再判。
   */
  function supersede(oldId, { by = '', reason = '' } = {}) {
    const oldOne = store.byId(oldId)
    if (!oldOne) throw new Error(`没有这条记忆：${oldId}`)
    const newId = by || oldOne.superseded_by
    if (!newId) throw new Error('要指明用哪条取代：supersede(oldId, { by })')
    const fresh = store.byId(newId)
    if (!fresh) throw new Error(`没有这条记忆：${newId}`)
    if (String(fresh.id) === String(oldOne.id)) throw new Error('不能自己取代自己')
    const why = String(reason || '').trim() || '手动指定'
    store.move(fresh, {
      supersedes: padId(oldOne.id),
      supersede_reason: why,
      status: 'active',
      updated: now(),
    }, { trigger })
    store.move(oldOne, {
      status: 'superseded',
      superseded_by: padId(fresh.id),
      updated: now(),
    }, { trigger })
    try { markRecompose(store, [oldOne.id, fresh.id]); } catch { /* 页不存在就跳过 */ }
    try { markScenesStale(store, [oldOne.id, fresh.id]); } catch { /* 没有场景就跳过 */ }
    log(`更正链：${padId(fresh.id)} 顶掉 ${padId(oldOne.id)}（${why}）`)
    reindex()
    return { old: padId(oldOne.id), by: padId(fresh.id), reason: why }
  }

  /** 反悔：把一条 superseded 的条目救回 active，并把对面那条的 supersedes 清掉 */
  function unsupersede(id) {
    const e = store.byId(id)
    if (!e) throw new Error(`没有这条记忆：${id}`)
    const otherId = e.superseded_by || e.supersedes
    const other = otherId ? store.byId(otherId) : null
    store.move(e, { status: 'active', superseded_by: '', supersedes: '', supersede_reason: '', updated: now() }, { trigger })
    if (other) {
      store.move(other, { superseded_by: '', supersedes: '', supersede_reason: '', updated: now() }, { trigger })
    }
    log(`撤销取代：${padId(id)}`)
    reindex()
    return { id: padId(id), other: other ? padId(other.id) : '' }
  }

  /* ---------- 运行状态（4B，.diag.json） ---------- */

  /** 4E-7：把五层各有多少东西摊平给诊断面板看 */
  function librarySummary() {
    const out = { sessions: 0, scenes: 0, skills: 0, pages: 0, suggestions: 0 }
    try {
      const dir = path.join(store.root, '_sessions')
      if (fs.existsSync(dir)) {
        for (const day of fs.readdirSync(dir)) {
          const d = path.join(dir, day)
          if (!fs.statSync(d).isDirectory()) continue
          out.sessions += fs.readdirSync(d).filter((n) => n.endsWith('.jsonl.zst')).length
        }
      }
    } catch { /* 数不出来不影响健康判断 */ }
    try { out.scenes = listScenes(store).length } catch { /* 忽略 */ }
    try { out.skills = listSkills(store).filter((s) => s.status === 'active').length } catch { /* 忽略 */ }
    try { out.pages = listPages(store).length } catch { /* 忽略 */ }
    try { out.suggestions = readSuggestions(store).items.length } catch { /* 忽略 */ }
    return out
  }

  function diag() {
    let raw = {}
    try { raw = JSON.parse(store.readText(path.join(store.root, '.diag.json')) || '{}') } catch { raw = {} }
    const counts = store.stats()
    const lastCapture = raw.capture?.at || ''
    const staleHours = lastCapture ? (Date.now() - Date.parse(lastCapture)) / 36e5 : null
    return {
      ...raw,
      counts: { total: counts.total, active: counts.active, pending: counts.pending, stale: counts.stale },
      staleHours: staleHours === null ? null : Math.round(staleHours * 10) / 10,
      vector: vectorStatus(),
      library: librarySummary(),
      health: raw.error && !raw.error.seen ? 'red' : (staleHours !== null && staleHours > 24 ? 'amber' : 'green'),
    }
  }

  function touchDiag(kind, patch = {}) {
    try {
      const file = path.join(store.root, '.diag.json')
      let raw = {}
      try { raw = JSON.parse(store.readText(file) || '{}') } catch { raw = {} }
      if (!raw.since) raw.since = now()
      raw[kind] = { at: now(), ...patch }
      store.atomicWrite(file, `${JSON.stringify(raw, null, 2)}\n`)
    } catch { /* 诊断写不进去不能影响主流程 */ }
  }

  /* ---------- 知识页 / 专题（4C-②，策划书 §23.4） ---------- */

  /** 煮一页：先按主题检索，再按类型分组摘抄；同 slug 幂等更新 */
  async function composeTopic({ topic = '', limit = 12, cwd = '' } = {}) {
    const name = String(topic || '').trim();
    if (!name) throw new Error('要给个主题：/memory 煮页 记忆库');
    const cfg = loadConfig(store.root);
    const want = Math.max(limit, Number(cfg.pages?.maxSources) || 12);
    // 煮页只吃「对当前上下文可见」的条目：不给 cwd 时，只属于某个项目的条目一律不进全局页
    const hits = await retrieve(name, { limit: want, includeInactive: false, cwd });
    const entries = hits
      .map((h) => store.byId(h.id))
      .filter(Boolean)
      .filter((e) => {
        if (cwd) return true;
        const scopes = Array.isArray(e.scope) ? e.scope : [e.scope];
        return !scopes.some((s) => String(s || '').startsWith('project:'));
      });
    // 4E-5：把引用这些条目的场景也当素材
    const ids = new Set(entries.map((e) => String(e.id)));
    const scenes = listScenes(store).filter((s) => (s.sources || []).some((id) => ids.has(String(id))));
    const built = composePage(store, {
      topic: name, entries, scenes, maxSources: want, related: [],
    });
    if (!built) return null;
    const info = savePage(store, built.page, { trigger: 'page' });
    log(`煮页 ${built.slug}：${built.sources.length} 条来源`);
    return { ...built.page, ...info };  // info: {slug, sourceCount, backlinked}
  }

  function pages() {
    return listPages(store).map((p) => ({ ...p, sourceCount: (p.sources || []).length }));
  }

  function page(slug) {
    const p = readPage(store, slug);
    if (!p) throw new Error(`没有这一页：${slug}`);
    return { ...p, sourceEntries: pageSources(store, slug).map(shape) };
  }

  function deletePage(slug) {
    const p = readPage(store, slug);
    if (!p) throw new Error(`没有这一页：${slug}`);
    try { fs.unlinkSync(p.pageFile || pageFilePath(slug)); } catch { /* 文件可能已不在 */ }
    for (const e of store.all()) {
      const list = String(e.page || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!list.includes(slug)) continue;
      store.move(e, { page: list.filter((s) => s !== slug).join(',') }, { trigger });
    }
    writePageIndexSafe();
    return { slug };
  }

  function pageFilePath(slug) { return path.join(store.dir('pages'), `${slug}.md`); }
  function writePageIndexSafe() { try { writePageIndex(store); } catch { /* 索引写不进去不影响页本身 */ } }

  /* ---------- 项目实体（4C-①，策划书 §23.8） ---------- */

  function projects() {
    const data = readProjects(store);
    const all = store.all();
    return data.projects.map((p) => {
      const used = all.filter((e) => (Array.isArray(e.scope) ? e.scope : [e.scope])
        .some((s) => String(s || '') === `project:${p.id}`));
      return {
        ...p,
        count: used.length,
        active: used.filter((e) => (e.status || 'active') === 'active').length,
      };
    });
  }

  function ensureProjectFor(cwd, { name = '' } = {}) {
    const cfg = loadConfig(store.root);
    return ensureProject(store, cwd, { autoCreate: cfg.projects?.autoCreate !== false, name });
  }

  function renameProject(id, name) {
    const data = readProjects(store);
    const p = findById(data, id);
    if (!p) throw new Error(`没有这个项目：${id}`);
    const next = String(name || '').trim();
    if (!next) throw new Error('项目名不能为空');
    p.name = next.slice(0, 40);
    writeProjects(store, data);
    reindex();
    return { ...p };
  }

  function addProjectPath(id, dir) {
    const data = readProjects(store);
    const p = findById(data, id);
    if (!p) throw new Error(`没有这个项目：${id}`);
    const target = String(dir || '').trim().replace(/[\\/]+$/, '');
    if (!target) throw new Error('路径不能为空');
    if (!p.paths.includes(target)) p.paths.push(target);
    writeProjects(store, data);
    return { ...p };
  }

  function removeProjectPath(id, dir) {
    const data = readProjects(store);
    const p = findById(data, id);
    if (!p) throw new Error(`没有这个项目：${id}`);
    p.paths = p.paths.filter((x) => x !== dir);
    writeProjects(store, data);
    return { ...p };
  }

  /** 合并两个项目：把 from 的路径并进 into，条目范围改写成 into，删掉 from */
  function mergeProjects(fromId, intoId) {
    if (String(fromId) === String(intoId)) throw new Error('不能自己合并自己');
    const data = readProjects(store);
    const from = findById(data, fromId);
    const into = findById(data, intoId);
    if (!from || !into) throw new Error('项目不存在');
    for (const p of from.paths) if (!into.paths.includes(p)) into.paths.push(p);
    data.projects = data.projects.filter((p) => String(p.id) !== String(from.id));
    writeProjects(store, data);
    let moved = 0;
    for (const e of store.all()) {
      const scopes = Array.isArray(e.scope) ? e.scope : [e.scope];
      if (!scopes.some((s) => String(s || '') === `project:${from.id}`)) continue;
      const next = scopes.map((s) => (String(s || '') === `project:${from.id}` ? `project:${into.id}` : s));
      store.move(e, { scope: next, updated: now() }, { trigger });
      moved += 1;
    }
    reindex();
    return { into: into.id, removed: from.id, moved };
  }

  function deleteProject(id) {
    const data = readProjects(store);
    const p = findById(data, id);
    if (!p) throw new Error(`没有这个项目：${id}`);
    const used = store.all().filter((e) => (Array.isArray(e.scope) ? e.scope : [e.scope])
      .some((s) => String(s || '') === `project:${p.id}`)).length;
    if (used) throw new Error(`还有 ${used} 条记忆挂在这个项目上，先把它们改到别的项目或删掉`);
    data.projects = data.projects.filter((x) => String(x.id) !== String(p.id));
    writeProjects(store, data);
    return { id: p.id };
  }

  /** 一次性规整：把老的 project:<路径> 范围改成实体 id（面板上要二次确认才调） */
  function normalizeScopes() {
    const cfg = loadConfig(store.root);
    let changed = 0;
    let created = 0;
    const before = readProjects(store).projects.length;
    for (const e of store.all()) {
      const scopes = Array.isArray(e.scope) ? e.scope : [e.scope];
      const next = toEntityScopes(store, scopes, { autoCreate: cfg.projects?.autoCreate !== false });
      if (next.join('|') === scopes.join('|')) continue;
      store.move(e, { scope: next, updated: now() }, { trigger });
      changed += 1;
    }
    created = readProjects(store).projects.length - before;
    if (changed) reindex();
    return { changed, created };
  }

  function config() { return loadConfig(store.root); }
  function setConfig(patch) { const c = saveConfig(store.root, patch); log('改配置'); return c; }

  /* ---------- 身份层（§23.1） ---------- */

  function persona() { return readPersona(store); }

  /** 面板与命令里要看的「实际会注入成什么样」 */
  function personaPreview() {
    const p = readPersona(store);
    return { persona: p, empty: personaEmpty(p), block: renderPersonaBlock(p) };
  }

  function setPersona(patch = {}) {
    const next = writePersona(store, patch);
    log('改身份：%s', Object.keys(patch).join(',') || '空');
    return next;
  }
  /* ---------- 4E-6 L4 画像建议（只给候选，采纳才写） ---------- */
  function suggestions() {
    return readSuggestions(store);
  }

  function refreshSugg() {
    const all = store.all().map(shape);
    const out = refreshSuggestions(store, { entries: all });
    touchDiag('suggest', { items: out.items.length });
    return { ...readSuggestions(store), persona: renderPersona(readPersona(store)) };
  }

  function acceptSuggestion(id) {
    const r = acceptSug(store, id);
    log(`采纳建议 ${id}`);
    return { ...r, items: readSuggestions(store).items };
  }

  function dismissSuggestion(id) {
    const r = dismissSug(store, id);
    return { ...r, items: readSuggestions(store).items };
  }

  function stats() { return { ...store.stats(), root: store.root }; }

  /* ---------- 换仓库位置 ---------- */

  /* 只搬记忆本体（*.md），不搬索引与口令：索引会按新内容重建，口令由面板自己带过去。 */
  function copyMarkdown(from, to) {
    let n = 0;
    const walk = (dir, rel) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        const relPath = rel ? path.join(rel, ent.name) : ent.name;
        if (ent.isDirectory()) { walk(abs, relPath); continue; }
        if (!ent.name.endsWith('.md')) continue;
        const dest = path.join(to, relPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (!fs.existsSync(dest)) { fs.copyFileSync(abs, dest); n += 1; }
      }
    };
    try { walk(from, ''); } catch { /* 老仓库不存在就当空 */ }
    return n;
  }

  /* 把记忆库改到 dir。copy=true 时把现有 .md 复制过去（不删旧的，随时能改回来）。 */
  function switchRoot(dir, { copy = true } = {}) {
    const raw = String(dir || '').trim().replace(/^"|"$/g, '');
    if (!raw) throw new Error('请填写文件夹路径');
    if (!path.isAbsolute(raw)) throw new Error('请填完整的绝对路径（从盘符开始）');
    const next = path.resolve(raw);
    if (next === store.root) return { from: next, to: next, copied: 0, changed: false };
    try {
      if (!fs.statSync(next).isDirectory()) throw new Error('这个路径是个文件，不是文件夹');
    } catch (e) {
      if (e.code === 'ENOENT') fs.mkdirSync(next, { recursive: true });
      else throw e;
    }
    const from = store.root;
    const copied = copy ? copyMarkdown(from, next) : 0;
    store = createStore({ root: next });
    store.ensure();
    if (copied) reindex();
    // 在默认位置留一个指针，重启后插件才知道仓库已经搬走了
    if (pointer) { try { saveConfig(defaultRoot(), { root: next }); } catch { /* 指针写不进去也不影响当前进程 */ } }
    // 换库不能把用户的选择丢掉：把当前配置带过去（writeMode 等），只把 root 换成新位置
    saveConfig(next, { ...loadConfig(from), root: next });
    log(`仓库从 ${from} 改到 ${next}（复制 ${copied} 个文件）`);
    return { from, to: next, copied, changed: true };
  }

  /* ---------- 维护（阶段 3） ---------- */

  /* 过期标记 + 日记蒸馏。auto=true 时插件启动会自己跑一次。 */
  function maintain({ staleDays = 90, dailyDays = 30 } = {}) {
    const cfg = loadConfig(store.root);
    const stale = markStale(store, { days: staleDays });
    // 说「当前/现在」的事实与决定，过一阵就不成立了：N 天没复核就降级成待确认，别再注入。
    const volatile = markVolatile(store, { days: cfg.maintenance?.volatileDays ?? 30 });
    const distilled = distillDailies(store, { days: dailyDays });
    let archived = null;
    if (cfg.maintenance?.autoArchive !== false) {
      archived = autoArchiveJournal(store, {
        maxLines: cfg.maintenance?.journalMaxLines ?? 400,
        maxBytes: cfg.maintenance?.journalMaxBytes ?? 32768,
      });
    }
    if (stale.length || volatile.length || distilled.length || archived) {
      log(`维护：${maintenanceReport({ stale, distilled })}${archived ? `；日记归档 ${archived.archive}` : ''}`);
      reindex();
    }
    let dupes = { scanned: false, groups: 0, merged: [], kept: [] }
    try { dupes = api.autoDedupe({}) } catch { /* 去重失败不影响维护 */ }
    const parts = [];
    if (stale.length) parts.push(`标过期 ${stale.length} 条`);
    if (volatile.length) parts.push(`复核降级 ${volatile.length} 条（${volatile.join('、')}）`);
    if (distilled.length) parts.push(`蒸馏 ${distilled.length} 天的日记`);
    if (archived) parts.push(`日记归档：${archived.lines} 行 → ${archived.archive}${archived.id ? `（摘录 #${archived.id}）` : ''}`);
    if (dupes.groups) parts.push(`重复 ${dupes.groups} 组${dupes.merged.length ? `（自动合并 ${dupes.merged.length} 组）` : ''}`);
    const summary = parts.length ? parts.join('；') : '没有需要处理的';
    touchDiag('maintain', { stale: stale.length, volatile: volatile.length, distilled: distilled.length, archived: archived ? archived.archive : '' });
    return { stale, volatile, distilled, archived, dupes, summary };
  }

  /* auto 模式撤回：最近的自动写入进垃圾桶，可再捞回。 */
  function undo(n = 1) {
    const taken = undoAuto(store, n);
    if (taken.length) { log(`撤回自动写入 ${taken.map((t) => t.id).join(', ')}`); reindex(); }
    return taken;
  }

  function autoWrites(limit = 10) {
    const log = readAutoLog(store);
    return log.entries.slice(-limit).reverse();
  }

  /* ---------- 冲突裁决 ---------- */

  /** choice: 'this' 留当前这条 / 'other' 留对面那条 / 'both' 都留（只是解除标记）。 */
  function resolveConflict(id, choice = 'both') {
    const a = store.byId(id)
    if (!a) throw new Error(`没有这条记忆：${id}`)
    const otherId = a.conflicts_with || a.conflict_with || a.superseded_by
    const b = otherId ? store.byId(otherId) : null
    const clear = { conflicts_with: '', conflict_with: '', updated: now() }
    if (choice === 'this' && b) {
      store.move(b, { ...clear, status: 'superseded', superseded_by: padId(a.id) }, { trigger })
      store.move(a, { ...clear, status: 'active' }, { trigger })
    } else if (choice === 'other' && b) {
      store.move(a, { ...clear, status: 'superseded', superseded_by: padId(b.id) }, { trigger })
      store.move(b, { ...clear, status: 'active' }, { trigger })
    } else {
      store.move(a, { ...clear, status: 'active' }, { trigger })
      if (b) store.move(b, { ...clear, status: 'active' }, { trigger })
    }
    log(`裁决冲突 ${padId(id)}：${choice}`)
    reindex()
    return { id: padId(id), choice, other: b ? padId(b.id) : '' }
  }

  const api = {
    list, counts, stats, accept, discard, edit, create,
    restore, purgeTrash,
    capture,
    landDistilled, retrieve, injection, touch, reindex, config, setConfig,
    persona, setPersona, personaPreview,
    shape, trashEntries, dailyCards, switchRoot,
    maintain, undo, autoWrites, resolveConflict, supersede, unsupersede, diag, touchDiag,
    /** 这条文本跟库里已有条目的最高相似度（0–1）；用来在调模型前掐掉重复 */
    /**
     * 找「库里的哪条跟这段话最像」（查重用）。
     * 有向量就按语义比（同一句话换个说法也能抓到），没向量退回 3-gram 字面比。
     * 返回 { score, id, via }。
     */
    async bestMatch(text, { type = '', scope = null } = {}) {
      const t = String(text || '')
      if (!t) return { score: 0, id: '', via: 'none' }
      const diag = {}
      const literal = () => {
        diag.fallback = true
        let best = 0
        let win = null
        for (const e of store.all()) {
          if (type && String(e.type || '') !== String(type)) continue
          const v = similarity(t, topicOf(e))
          if (v > best) { best = v; win = e }
        }
        const verdict = dupeVerdict({ text: t, type, scope }, win)
        diag.kw = verdict.kw
        return { score: best, id: String(win?.id || ''), via: 'text', dup: verdict.dup, why: verdict.why, diag }
      }
      try {
        diag.vectorOn = vectorEnabled(api.config())
        if (!diag.vectorOn) return literal()
        const data = readVectors(store)
        const have = data?.items && Object.keys(data.items).length
        diag.have = have || 0
        if (!have) return literal()
        const emb = await getEmbedder(api.config())
        diag.emb = !!emb
        diag.embError = emb ? String(emb.error || '') : 'null'
        if (!emb || emb.error) return literal()
        const [vec] = await emb.embed([t])
        diag.vec = Array.isArray(vec) ? vec.length : 'not-array'
        if (!Array.isArray(vec)) return literal()
        let best = 0
        let win = null
        for (const e of store.all()) {
          if (type && String(e.type || '') !== String(type)) continue
          const hit = data.items[String(e.id || '')]
          if (!hit?.v) continue
          const v = cosine(vec, hit.v)
          if (v > best) { best = v; win = e }
        }
        if (!best) return literal()
        diag.max = best
        const verdict = dupeVerdict({ text: t, type, scope }, win)
        diag.kw = verdict.kw
        return { score: best, id: String(win?.id || ''), via: 'vector', dup: verdict.dup, why: verdict.why }
      } catch (error) {
        diag.error = String(error?.message ?? error)
        return { ...literal(), diag }
      } finally { lastDiag = diag }
    },
    matchDiag() { return lastDiag },
    maxSimilarity(text) {
      const t = String(text || '')
      if (!t) return 0
      let best = 0
      for (const e of store.all()) {
        const s = similarity(t, String(e.title || '') + ' ' + String(e.body || ''))
        if (s > best) best = s
      }
      return best
    },
    vectorStatus, embedAll,
    composeTopic, pages, page, deletePage, markRecompose,
    suggestions, refreshSugg, acceptSuggestion, dismissSuggestion,
    landScenes, scenes, scene, removeScene, scenesOf, writeSceneIndex,
    landSkills, skills, skill, removeSkill, skillLines, writeSkillIndex,
    projects, ensureProjectFor, renameProject, addProjectPath, removeProjectPath, mergeProjects, deleteProject, normalizeScopes,
  };
  // root / store 必须是活取值：换了位置以后，面板与命令读到的要立刻是新仓库
  Object.defineProperty(api, 'root', { enumerable: true, get: () => store.root });
  Object.defineProperty(api, 'store', { enumerable: true, get: () => store });
  // 可能重复：直接相似（不传递成簇），每组给一个建议保留的「主条」
  /**
   * 自动去重：扫描「可能重复」；auto 模式下按「分数够 + 同类型」自动合并。
   * semi / manual 只扫描不合并（留给人点）。
   */
  api.autoDedupe = ({ threshold, minScore, max, mode } = {}) => {
    const cfg = loadConfig(store.root)
    const dc = cfg.dupes || {}
    if (dc.autoScan === false) return { scanned: false, groups: 0, merged: [], kept: [] }
    const th = Number(threshold ?? dc.threshold ?? 0.88)
    const min = Number(minScore ?? dc.autoMergeScore ?? 0.92)
    const cap = Number(max ?? dc.maxPerRun ?? 5)
    const scan = api.findDuplicates({ threshold: th })
    const out = { scanned: true, threshold: th, groups: scan.groups.length, merged: [], kept: [] }
    const modeNow = String(mode || cfg.writeMode || '')
    if (modeNow !== 'auto' || dc.autoMerge === false) return out
    for (const g of scan.groups.slice(0, Math.max(1, cap))) {
      const strong = g.others.every((o) => Number(o.score) >= min)
      const sameType = g.others.every((o) => String(o.type || '') === String(g.keep.type || ''))
      if (!strong || (dc.autoMergeSameTypeOnly !== false && !sameType)) { out.kept.push(g.keep.id); continue }
      try {
        api.mergeDuplicates(g.keep.id, g.others.map((o) => String(o.id)), '自动去重：与 ' + g.keep.id + ' 同义')
        out.merged.push({ keep: g.keep.id, others: g.others.map((o) => String(o.id)) })
      } catch { out.kept.push(g.keep.id) }
    }
    if (out.merged.length) touchDiag('dupes', { groups: out.groups, merged: out.merged.length })
    return out
  }

  api.findDuplicates = ({ threshold = 0.88 } = {}) => {
    const byId = new Map()
    for (const e of store.all()) {
      if (String(e.status || '') !== 'active') continue
      byId.set(String(e.id || ''), e)
    }
    const data = readVectors(store)
    const items = (data && data.items) || {}
    const ids = Object.keys(items).filter((k) => byId.has(k))
    const rank = (e) => ({
      s: String(e.status || '') === 'active' ? 2 : 1,
      p: isPinned(e.priority) ? 1 : 0,
      l: String(e.body || '').length,
      t: String(e.created || '')
    })
    const sorted = ids.slice().sort((a, b) => {
      const A = rank(byId.get(a)); const B = rank(byId.get(b))
      return B.s - A.s || B.p - A.p || B.l - A.l || (B.t > A.t ? 1 : B.t < A.t ? -1 : 0)
    })
    const used = new Set()
    const groups = []
    for (const k of sorted) {
      if (used.has(k)) continue
      used.add(k)
      const others = []
      for (const o of sorted) {
        if (used.has(o)) continue
        const s = cosine(items[k].v, items[o].v)
        if (s >= threshold) { used.add(o); others.push({ id: o, score: Number(s.toFixed(3)) }) }
      }
      if (others.length) groups.push({ keep: k, others })
    }
    return {
      threshold,
      groups: groups.map((g) => {
        const k = byId.get(g.keep)
        return {
          keep: { id: g.keep, title: k.title, type: k.type, status: k.status, body: String(k.body || '').slice(0, 120) },
          others: g.others.map((o) => {
            const e = byId.get(o.id)
            return { id: o.id, score: o.score, title: e.title, type: e.type, status: e.status, body: String(e.body || '').slice(0, 120) }
          })
        }
      }),
      pairs: groups.reduce((n, g) => n + g.others.length, 0)
    }
  }

  // 合并一组：主条留下，其余标 superseded（可恢复，不删除）
  api.mergeDuplicates = (keepId, otherIds = [], reason = '') => {
    const keep = store.byId(String(keepId))
    if (!keep) throw new Error('没有这条记忆：' + keepId)
    const done = []
    for (const id of otherIds) {
      if (String(id) === String(keepId)) continue
      const one = store.byId(String(id))
      if (!one) continue
      api.supersede(one.id, { by: keep.id, reason: reason || '去重：与 ' + keepId + ' 同义' })
      done.push(String(one.id))
    }
    api.reindex()
    return { keep: String(keepId), merged: done }
  }

  return api;
}
