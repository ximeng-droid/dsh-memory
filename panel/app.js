/* 面板前端：只做三件事——取数据、画界面、把点击变成请求。
   后端就是同目录上一层的 lib/panel.js（/memory/api/*）。 */
'use strict';

const TYPES = {
  preference: '偏好', forbidden: '禁忌', decision: '决策', experience: '经验',
  fact: '事实', project: '项目', knowledge: '知识', map: '地图', profile: '画像',
};
const SCOPES = { global: '全局' };
const STATUS = {
  pending: '待确认', active: '生效中', superseded: '已被覆盖',
  stale: '久未用', archived: '已归档', rejected: '已丢弃',
  conflict: '有冲突', trashed: '在垃圾桶',
};

const el = (sel, root = document) => root.querySelector(sel);
const els = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ui = {
  rows: el('#rows'), detail: el('#detail'), listhead: el('.listhead'), chips: el('.filters'),
  rail: el('.rail'), search: el('.search input'), foot: el('.listfoot .right'),
  crumb: el('.crumb strong'), title: el('h2', el('.listhead')),
};

const state = {
  pages: [], slug: '', pageDetail: null, projects: [],
  scenes: [], sceneId: '', sceneDetail: null,
  dups: [], dupPick: '',
  skills: [], skillSlug: '', skillDetail: null,
  view: 'pending', q: '', entries: [], counts: null, meta: null,
  sel: 0, config: null, editing: null, pickSupersede: '',
};

/* ---------------- 工具 ---------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hhmm(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return String(iso).slice(5, 16).replace('T', ' ');
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function scopeLabel(scope) {
  const list = Array.isArray(scope) ? scope : [];
  if (!list.length || list.includes('global')) return { text: '全局', proj: false };
  const one = list[0].replace(/^project:/, '').split(/[\\/]/).filter(Boolean).pop() || list[0];
  return { text: `项目 · ${one}`, proj: true };
}

function typeLabel(t) { return TYPES[t] || t; }

async function api(path, opt = {}) {
  const res = await fetch(`api/${path}`, {
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    ...opt,
  });
  if (res.status === 401) { location.href = 'login.html'; throw new Error('未登录'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

/* ---------------- 渲染 ---------------- */
function libCount(kind, list) {
  const lib = state.lib || {};
  const v = Number(lib[kind]);
  if (Number.isFinite(v) && v > 0) return v;
  return (list || []).length;
}

function renderRail() {
  const c = state.counts || { pending: 0, all: 0, byType: {}, trash: 0, today: '—' };
  const nav = el('nav.rail');
  const rowsHtml = `
    <h3>收件</h3>
    <ul>
      <li><a href="#" data-view="pending" class="${state.view === 'pending' ? 'on' : ''}"><i data-ico="inbox"></i><span>待确认</span><span class="n">${c.pending}</span></a></li>
      <li><a href="#" data-view="all" class="${state.view === 'all' ? 'on' : ''}"><i data-ico="stack"></i><span>全部记忆</span><span class="n">${c.all}</span></a></li>
    </ul>
    <h3>按类型</h3>
    <ul>
      <li><a href="#" data-view="type:preference" class="${state.view === 'type:preference' ? 'on' : ''}"><i data-ico="tag"></i><span>偏好</span><span class="n">${c.byType.preference || 0}</span></a></li>
      <li><a href="#" data-view="type:project" class="${state.view === 'type:project' ? 'on' : ''}"><i data-ico="folder"></i><span>项目</span><span class="n">${c.byType.project || 0}</span></a></li>
      <li><a href="#" data-view="type:fact" class="${state.view === 'type:fact' ? 'on' : ''}"><i data-ico="check"></i><span>事实</span><span class="n">${c.byType.fact || 0}</span></a></li>
      <li><a href="#" data-view="type:decision" class="${state.view === 'type:decision' ? 'on' : ''}"><i data-ico="pencil"></i><span>决策</span><span class="n">${c.byType.decision || 0}</span></a></li>
      <li><a href="#" data-view="type:map" class="${state.view === 'type:map' ? 'on' : ''}"><i data-ico="graph"></i><span>地图</span><span class="n">${c.byType.map || 0}</span></a></li>
    </ul>
    <h3>其他</h3>
    <ul>
      <li><a href="#" data-view="daily" class="${state.view === 'daily' ? 'on' : ''}"><i data-ico="cal"></i><span>日记</span><span class="n">${c.today}</span></a></li>
      <li><a href="#" data-view="pages" class="${state.view === 'pages' ? 'on' : ''}"><i data-ico="graph"></i><span>专题</span><span class="n">${libCount('pages', state.pages)}</span></a></li>
      <li><a href="#" data-view="scenes" class="${state.view === 'scenes' ? 'on' : ''}"><i data-ico="cal"></i><span>场景</span><span class="n">${libCount('scenes', state.scenes)}</span></a></li>
      <li><a href="#" data-view="dups" class="${state.view === 'dups' ? 'on' : ''}"><i data-ico="copy"></i><span>可能重复</span><span class="n" id="dupCount">${state.dups.length || ''}</span></a></li>
      <li><a href="#" data-view="skills" class="${state.view === 'skills' ? 'on' : ''}"><i data-ico="pencil"></i><span>技能</span><span class="n">${libCount('skills', state.skills)}</span></a></li>
      <li><a href="#" data-view="trash" class="${state.view === 'trash' ? 'on' : ''}"><i data-ico="trash"></i><span>垃圾桶</span><span class="n">${c.trash}</span></a></li>
    </ul>`;
  const foot = el('.foot', nav);
  const tmp = el('.rail .tmp');
  if (!tmp) {
    const wrap = document.createElement('div');
    wrap.className = 'tmp';
    wrap.innerHTML = rowsHtml;
    nav.insertBefore(wrap, foot);
    els('a[data-view]', wrap).forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      state.view = a.dataset.view; state.sel = 0; state.q = ''; if (ui.search) ui.search.value = '';
      load();
    }));
  } else {
    tmp.innerHTML = rowsHtml;
    els('a[data-view]', tmp).forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      state.view = a.dataset.view; state.sel = 0; state.q = ''; if (ui.search) ui.search.value = '';
      load();
    }));
  }
  const dot = el('.status span:last-child');
  if (dot && state.meta) dot.textContent = `本地服务运行中 · ${state.meta.entries} 条记忆`;
}

function renderHead() {
  const n = state.entries.length;
  const meta = el('.listhead .meta');
  const c = state.counts || {};
  const name = { pending: '待确认箱', all: '全部记忆', trash: '垃圾桶', daily: '日记', pages: '专题', scenes: '场景', skills: '技能', dups: '可能重复' }[state.view]
    || `按类型 · ${typeLabel(state.view.replace('type:', ''))}`;
  if (ui.title) ui.title.textContent = name;
  if (ui.crumb) ui.crumb.textContent = name;
  if (meta) {
    if (state.view === 'pending') {
      const oldest = state.entries.length ? state.entries[state.entries.length - 1].created : null;
      meta.textContent = `${n} 条 · 最早 ${oldest ? hhmm(oldest).slice(0, 5) : '—'} · 7 天后自动降级为日记`;
    } else if (state.view === 'trash') {
      meta.textContent = `${n} 条 · 已丢弃的记忆留着，可以随时恢复`;
    } else if (state.view === 'skills') {
      meta.textContent = `${state.skills.length} 张技能卡 · 只把标题与关键词注入，全文靠检索`;
    } else if (state.view === 'dups') {
      meta.textContent = `${state.dups.length} 组 · 意思相近的记忆，点「合并这组」把它们并成一条（可恢复）`;
    } else if (state.view === 'scenes') {
      meta.textContent = `${state.scenes.length} 个场景 · 每次任务一段，不进注入`;
    } else if (state.view === 'pages') {
      meta.textContent = `${state.pages.length} 个专题 · 把同主题的记忆煮成一页`;
    } else {
      meta.textContent = `${n} 条 · 共 ${c.all ?? n} 条在库`;
    }
  }
  const acts = el('.listhead .acts');
  if (acts) acts.style.display = state.view === 'pending' ? '' : 'none';
}

function renderChips() {
  const box = el('.filters');
  if (!box) return;
  if (state.view !== 'pending') { box.style.display = 'none'; return; }
  box.style.display = '';
  const byType = {};
  for (const e of state.entries) byType[e.type] = (byType[e.type] || 0) + 1;
  const order = ['preference', 'fact', 'decision', 'experience', 'project', 'knowledge', 'map', 'forbidden'];
  const items = [`<button class="chip" data-chip aria-pressed="${state.q === '' ? 'true' : 'false'}">全部 <span class="c">${state.entries.length}</span></button>`];
  for (const t of order) {
    if (!byType[t]) continue;
    items.push(`<button class="chip" data-chip aria-pressed="false">${typeLabel(t)} <span class="c">${byType[t]}</span></button>`);
  }
  box.innerHTML = items.join('');
}

function rowHtml(e, i) {
  const s = scopeLabel(e.scope);
  const why = (e.rules || []).slice(0, 2).join(' · ');
  const pend = e.status === 'pending';
  return `<div class="row" data-row data-i="${i}" tabindex="0" role="option" aria-selected="${i === state.sel}">
    <div class="line1"><span class="ttl">${esc(e.title)}</span></div>
    <p class="sub">${esc(e.body)}</p>
    <div class="line3">
      <span class="pill type">${esc(typeLabel(e.type))}</span>
      <span class="pill scope${s.proj ? ' proj' : ''}">${esc(s.text)}</span>
      ${why ? `<span class="why">命中：<b>${esc(why)}</b></span>` : ''}
      <span class="time">${hhmm(e.created)}</span>
    </div>
    ${pend ? `<div class="quick">
      <button class="mini yes" data-act="accept"><i data-ico="check"></i>收下</button>
      <button class="mini" data-act="discard"><i data-ico="x"></i>丢弃</button>
    </div>` : ''}
  </div>`;
}

function pageRowHtml(p, i) {
  const first = String(p.body || '')
    .replace(/^##[^\n]*\n?/gm, '')
    .replace(/^- /gm, '')
    .split('\n')
    .filter(Boolean)[0] || '';
  return `<div class="row" data-row="1" data-i="${i}" aria-selected="${p.slug === state.slug}">
    <div class="line1"><span class="ttl">${esc(p.title)}</span>
      <span class="meta-r">${p.sourceCount || 0} 条来源 · ${hhmm(p.updated)}</span></div>
    <p class="sub">${esc(String(p.description || first).slice(0, 120))}</p>
    <div class="line3"><span class="pill">专题</span><span class="pill">${esc(p.slug)}</span>${p.needs_recompose ? '<span class="pill warn">需重煮</span>' : ''}</div>
  </div>`;
}

function skillRowHtml(k, i) {
  const kw = (k.keywords || []).slice(0, 3).join('、');
  return `<div class="row" data-row="1" data-i="${i}" aria-selected="${k.slug === state.skillSlug}">
    <div class="line1"><span class="ttl">${esc(k.title)}</span>
      <span class="meta-r">${k.status === 'active' ? '生效' : '待确认'} · ${hhmm(k.updated)}</span></div>
    <p class="sub">${esc(String(k.when || '').slice(0, 120))}</p>
    <div class="line3"><span class="pill">技能</span>${kw ? `<span class="pill">${esc(kw)}</span>` : ''}</div>
  </div>`;
}

function sceneRowHtml(s, i) {
  return `<div class="row" data-row="1" data-i="${i}" aria-selected="${s.id === state.sceneId}">
    <div class="line1"><span class="ttl">${esc(s.title)}</span>
      <span class="meta-r">${s.turns ? 'T' + s.turns[0] + '-' + s.turns[1] : ''} ${hhmm(s.started || s.created)}</span></div>
    <p class="sub">${esc(String(s.goal || '').slice(0, 120))}</p>
    <div class="line3"><span class="pill">场景</span><span class="pill">${esc(s.id)}</span>${s.stale ? '<span class="pill warn">需重煮</span>' : ''}</div>
  </div>`;
}

function renderRows() {
  const box = el('#rows');
  if (!box) return;
  if (state.view === 'skills') {
    if (!state.skills.length) {
      box.innerHTML = `<div class="row" style="cursor:default"><div class="line1"><span class="ttl">还没有技能卡</span></div>
        <p class="sub">蒸馏时出现「可复用的做法」会自动写成技能卡；也可以 /memory 技能 看已有的。</p></div>`;
    } else {
      box.innerHTML = state.skills.map(skillRowHtml).join('');
      els('.row[data-row]', box).forEach((r) => r.addEventListener('click', async () => {
        state.skillSlug = state.skills[Number(r.dataset.i)]?.slug || '';
        renderRows();
        await loadSkillDetail();
        renderDetail();
      }));
    }
    if (ui.foot) ui.foot.textContent = `共 ${state.skills.length} 张技能卡`;
    return;
  }
  if (state.view === 'dups') {
    if (!state.dups.length) {
      box.innerHTML = `<div class="row" style="cursor:default"><div class="line1"><span class="ttl">没有发现重复</span></div>
        <p class="sub">按「意思相近」扫了一遍，没找到需要合并的。</p></div>`;
    } else {
      box.innerHTML = state.dups.map((g, i) => {
        const k = g.keep;
        return `<div class="row" data-row data-i="${i}" aria-selected="${i === 0 ? 'true' : 'false'}">
          <div class="line1"><span class="pill warn">${g.others.length + 1} 条</span><span class="ttl">${esc(k.title)}</span></div>
          <p class="sub">保留这条，合并：${esc(g.others.map((o) => '#' + o.id + ' ' + o.title).join('；'))}</p>
          <div class="line3"><span class="pill">${esc(k.type)}</span><span class="why">${esc((k.body || '').slice(0, 60))}</span>
            <span class="time"><button class="btn small" data-merge="${i}">合并这组</button></span></div>
        </div>`;
      }).join('');
      els('[data-merge]', box).forEach((b) => b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const g = state.dups[Number(b.dataset.merge)];
        if (!g) return;
        if (!confirm(`把 ${g.others.length} 条并进 #${g.keep.id}？被并的会标「已被覆盖」，随时能恢复。`)) return;
        await api('duplicates/merge', { method: 'POST', body: JSON.stringify({ keep: g.keep.id, others: g.others.map((o) => o.id) }) });
        await load();
      }));
    }
    if (ui.foot) ui.foot.textContent = `共 ${state.dups.length} 组`;
    return;
  }
  if (state.view === 'scenes') {
    if (!state.scenes.length) {
      box.innerHTML = `<div class="row" style="cursor:default"><div class="line1"><span class="ttl">还没有场景</span></div>
        <p class="sub">会话蒸馏时会顺带切出场景；也可以在设置里点「蒸馏一次」。</p></div>`;
    } else {
      box.innerHTML = state.scenes.map(sceneRowHtml).join('');
      els('.row[data-row]', box).forEach((r) => r.addEventListener('click', async () => {
        state.sceneId = state.scenes[Number(r.dataset.i)]?.id || '';
        renderRows();
        await loadSceneDetail();
        renderDetail();
      }));
    }
    if (ui.foot) ui.foot.textContent = `共 ${state.scenes.length} 个场景`;
    return;
  }
  if (state.view === 'pages') {
    if (!state.pages.length) {
      box.innerHTML = `<div class="row" style="cursor:default"><div class="line1"><span class="ttl">还没有专题</span></div>
        <p class="sub">在会话里说 /memory 煮页 pnpm，或在设置里按主题煮一页。</p></div>`;
    } else {
      box.innerHTML = state.pages.map(pageRowHtml).join('');
      els('.row[data-row]', box).forEach((r) => r.addEventListener('click', async () => {
        state.slug = state.pages[Number(r.dataset.i)]?.slug || '';
        renderRows();
        await loadPageDetail();
        renderDetail();
      }));
    }
    if (ui.foot) ui.foot.textContent = `共 ${state.pages.length} 个专题`;
    return;
  }
  if (!state.entries.length) {
    box.innerHTML = `<div class="row" style="cursor:default"><div class="line1"><span class="ttl">${state.q ? '没搜到' : state.view === 'pending' ? '待确认箱是空的' : '这里还没有记忆'}</span></div>
      <p class="sub">${state.q ? `换个词试试；也可以只输编号，例如 41。` : '继续干活就行，达到门槛的会被自动收进来。'}</p></div>`;
  } else {
    box.innerHTML = state.entries.map(rowHtml).join('');
  }
  els('.row[data-row]', box).forEach((r) => {
    r.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      const i = Number(r.dataset.i);
      // 「顶掉另一条」的选人阶段：点谁就用当前那条顶掉谁
      if (state.pickSupersede && String(state.entries[i]?.id) !== String(state.pickSupersede)) {
        const by = state.pickSupersede;
        const old = state.entries[i];
        state.pickSupersede = '';
        try {
          await api('entry/supersede', { method: 'POST', body: JSON.stringify({ old: old.id, by, reason: '手动指定' }) });
          await load();
        } catch (err) { alert(err.message); }
        return;
      }
      state.sel = i;
      if (btn) { act(btn.dataset.act, state.entries[i]); return; }
      renderRows(); renderDetail();
    });
  });
  box.classList.toggle('picking', !!state.pickSupersede);
  if (ui.foot) ui.foot.textContent = `已选 ${state.entries.length ? state.sel + 1 : 0} 条 · 共 ${state.entries.length} 条`;
}

/* ---------------- 编辑器（新增 / 编辑） ---------------- */

function projectScopes() {
  const set = new Set();
  for (const e of state.entries || []) {
    for (const sc of e.scope || []) {
      const s = String(sc);
      if (s.startsWith('project:')) set.add(s.slice(8));
    }
  }
  return [...set].filter(Boolean).slice(0, 8);
}

function openEditor(entry) {
  const e = entry || { id: null, title: '', body: '', type: 'fact', scope: ['global'], priority: 'normal' };
  state.editing = {
    id: e.id || null, title: e.title || '', body: e.body || '',
    type: TYPES[e.type] ? e.type : 'fact',
    scope: scopesOf(e), priority: e.priority ?? 1,
  };
  renderDetail();
  if (window.__dshIcons) window.__dshIcons();
  const t = el('#edTitle');
  if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
}

function scopesOf(e) {
  const arr = Array.isArray(e.scope) ? e.scope.map(String) : [];
  const proj = arr.find((s) => s.startsWith('project:'));
  if (proj) return 'project:' + proj.slice(8);
  return 'global';
}

function editorHtml() {
  const ed = state.editing;
  const isNew = !ed.id;
  const isProj = String(ed.scope).startsWith('project:');
  const projPath = isProj ? String(ed.scope).slice(8) : '';
  const opts = Object.entries(TYPES)
    .filter(([k]) => k !== 'map')
    .map(([k, v]) => `<option value="${k}"${ed.type === k ? ' selected' : ''}>${v}</option>`).join('');
  return `
    <div class="head">
      <div class="idline"><span>${isNew ? '新增一条记忆' : `编辑 #${esc(String(ed.id).replace(/^0+/, ''))}`}</span></div>
      <h1>${isNew ? '记下什么？' : esc(ed.title)}</h1>
    </div>
    <div class="editor">
      <label class="fld"><span>标题</span>
        <input id="edTitle" maxlength="40" value="${esc(ed.title)}" placeholder="一句话，40 字以内"></label>
      <label class="fld"><span>正文</span>
        <textarea id="edBody" maxlength="300" rows="6" placeholder="结论 + 为什么，300 字以内">${esc(ed.body)}</textarea></label>
      <div class="two">
        <label class="fld"><span>类型</span><select id="edType">${opts}</select></label>
        <label class="fld"><span>范围</span>
          <select id="edScopeKind">
            <option value="global"${isProj ? '' : ' selected'}>全局</option>
            <option value="project"${isProj ? ' selected' : ''}>只在这个项目</option>
          </select></label>
      </div>
      <label class="fld" id="edProjWrap"${isProj ? '' : ' hidden'}><span>项目路径</span>
        <input id="edProjPath" value="${esc(projPath)}" placeholder="D:\\work\\某项目" list="edProjList">
        <datalist id="edProjList">${projectScopes().map((p) => `<option value="${esc(p)}">`).join('')}</datalist></label>
      <label class="fld row-inline"><span>重要度</span>
        <label class="chk"><input type="checkbox" id="edPin"${Number(ed.priority) >= 2 || ed.priority === 'pinned' ? ' checked' : ''}> 置顶（每轮优先注入，最多 3 条）</label></label>
      <p class="hint">存下来就生效，参与每轮注入；写错了可以再改，旧版会留在 _trash/历史 里。</p>
    </div>`;
}

async function saveEditor() {
  const ed = state.editing;
  if (!ed) return;
  const title = (el('#edTitle')?.value || '').trim();
  if (!title) { alert('标题不能为空'); el('#edTitle')?.focus(); return; }
  const body = (el('#edBody')?.value || '').trim();
  const type = el('#edType')?.value || 'fact';
  const kind = el('#edScopeKind')?.value || 'global';
  let scope = 'global';
  if (kind === 'project') {
    const p = (el('#edProjPath')?.value || '').trim();
    if (!p) { alert('选了「只在这个项目」就要填路径'); el('#edProjPath')?.focus(); return; }
    scope = 'project:' + p;
  }
  const pinned = !!el('#edPin')?.checked;
  const payload = { title, body, type, scope, priority: pinned ? 2 : 1 };
  try {
    if (ed.id) await api(`entry/${ed.id}/edit`, { method: 'POST', body: JSON.stringify(payload) });
    else await api('entry/new', { method: 'POST', body: JSON.stringify(payload) });
    state.editing = null;
    await load();
  } catch (err) { alert(err.message); }
}

/* 冲突裁决卡片：两条互斥，让用户当场选留哪条 */
function conflictHtml(e) {
  if (e.status !== 'conflict') return '';
  const other = (state.entries || []).find((x) => String(x.id) === String(e.conflicts_with));
  const otherLine = other
    ? `<li><b>#${esc(String(other.id).replace(/^0+/, ''))}</b> ${esc(other.title)}<div class="sub">${esc(other.body)}</div></li>`
    : `<li>#${esc(String(e.conflicts_with || '?').replace(/^0+/, ''))}（对面那条不在当前列表里，切到「全部记忆」就能看到）</li>`;
  return `
    <div class="sect conflictbox">
      <h2 class="sect-t">这条和另一条打架，留哪个？</h2>
      <p class="sub">两条说法不能同时成立。选一个保留，另一条会标成「被替代」留档，不删。</p>
      <ul class="conflictlist">${otherLine}</ul>
      <div class="conflictacts">
        <button class="btn primary" data-cf="this">留这条</button>
        <button class="btn" data-cf="other">留对面那条</button>
        <button class="btn ghost" data-cf="both">两条都留</button>
      </div>
    </div>`;
}

function pageDetailHtml(p) {
  const bodyHtml = esc(p.body || '')
    .replace(/^## (.+)$/gm, '<h4>$1</h4>')
    .replace(/^- (.+)$/gm, '<div class="pl">· $1</div>')
    .replace(/\[\[page:([a-z0-9-]+)\]\]/g, '<button class="lnk" data-page="$1">$1</button>');
  const src = (p.sourceEntries || []).map((e) => `<div class="src" data-row="1" data-id="${e.id}">
      <span class="pill">${typeLabel(e.type)}</span>
      <span class="st">${esc(e.title)}</span>
      <span class="n">${e.id}</span></div>`).join('') || '<div class="hint">这页没有来源了（来源条目可能被删了）</div>';
  return `<div class="phead">
    <div class="line1"><span class="ttl">${esc(p.title)}</span></div>
    <div class="chips"><span class="pill">专题</span><span class="pill">${esc(p.slug)}</span>
      <span class="pill">${(p.sources || []).length} 条来源</span><span class="pill">更新 ${hhmm(p.updated)}</span>
    ${p.needs_recompose ? '<span class="pill warn">需重煮</span>' : ''}</div>
    ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ''}
    ${p.needs_recompose ? '<div class="warnbox"><b>来源变过了，这页可能过期</b><div class="hint">有来源条目被删除或被取代过。点下面「重新煮一遍」按现在的条目重写。</div></div>' : ''}
  </div>
  <div class="body pbody">${bodyHtml}</div>
  <div class="sect"><h4>来源条目</h4>${src}</div>`;
}

async function loadSkillDetail() {
  if (!state.skillSlug) { state.skillDetail = null; return; }
  try {
    const data = await api(`skill?slug=${encodeURIComponent(state.skillSlug)}`);
    state.skillDetail = data.skill || null;
  } catch { state.skillDetail = null; }
}

function skillDetailHtml(k) {
  const list = (arr) => (arr || []).map((x) => `<div class="pl">· ${esc(x)}</div>`).join('') || '<div class="hint">（没有）</div>';
  return `<div class="phead">
    <div class="line1"><span class="ttl">${esc(k.title)}</span></div>
    <div class="chips"><span class="pill">技能</span>
      <span class="pill">${k.status === 'active' ? '生效中' : '待确认'}</span>
      ${(k.keywords || []).length ? `<span class="pill">${esc((k.keywords || []).join('、'))}</span>` : ''}
      <span class="pill">用 ${k.uses || 0} 次</span></div>
  </div>
  <div class="body pbody">
    <h4>什么时候用</h4><div class="pl">${esc(k.when || '（没有）')}</div>
    <h4>怎么做</h4>${list(k.how)}
    <h4>坑</h4>${list(k.pitfalls)}
    <h4>验证</h4><div class="pl">${esc(k.verify || '（没有）')}</div>
  </div>
  <div class="sect"><h4>属性</h4>
    <dl class="props">
      <dt>作用域</dt><dd>${esc((k.scope || []).join('、') || '—')}</dd>
      <dt>来源</dt><dd>${esc(k.source || '—')}</dd>
      <dt>更新</dt><dd>${esc(k.updated || '—')}</dd>
      <dt>文件</dt><dd class="mono"><span class="path"><i data-ico="folder"></i>${esc(k.file || '')}</span></dd>
    </dl>
  </div>`;
}

async function loadSceneDetail() {
  if (!state.sceneId) { state.sceneDetail = null; return; }
  try {
    const data = await api(`scene?id=${encodeURIComponent(state.sceneId)}`);
    state.sceneDetail = data.scene || null;
  } catch { state.sceneDetail = null; }
}

function sceneDetailHtml(s) {
  const list = (arr) => (arr || []).map((x) => `<div class="pl">· ${esc(x)}</div>`).join('') || '<div class="hint">（没有）</div>';
  return `<div class="phead">
    <div class="line1"><span class="ttl">${esc(s.title)}</span></div>
    <div class="chips"><span class="pill">场景</span><span class="pill">${esc(s.id)}</span>
      ${s.turns ? `<span class="pill">第 ${s.turns[0]}–${s.turns[1]} 轮</span>` : ''}
      ${s.project ? `<span class="pill">${esc(s.project)}</span>` : ''}${s.stale ? '<span class="pill warn">需重煮</span>' : ''}</div>
  </div>
  ${s.stale ? `<div class="warnbox"><b>来源失效了</b>这条记忆被丢弃或删掉了（${(s.stale_sources || []).join('、')}），这个场景的结论可能过期。</div>` : ''}
  <div class="body pbody">
    <h4>目标</h4><div class="pl">${esc(s.goal || '（没有）')}</div>
    <h4>怎么做的</h4>${list(s.steps)}
    <h4>结果</h4><div class="pl">${esc(s.result || '（没有）')}</div>
    <h4>留下的坑</h4>${list(s.pitfalls)}
  </div>
  <div class="sect"><h4>属性</h4>
    <dl class="props">
      <dt>会话</dt><dd>${esc(s.session || '—')}</dd>
      <dt>开始</dt><dd>${esc(s.started || '—')}</dd>
      <dt>来源条目</dt><dd>${(s.sources || []).join(' ') || '—'}</dd>
      <dt>文件</dt><dd class="mono"><span class="path"><i data-ico="folder"></i>${esc(s.file || '')}</span></dd>
    </dl>
  </div>`;
}

async function loadPageDetail() {
  if (!state.slug) { state.pageDetail = null; return; }
  try {
    const data = await api(`page?slug=${encodeURIComponent(state.slug)}`);
    state.pageDetail = data.page || null;
  } catch { state.pageDetail = null; }
}

function renderDetail() {
  const box = el('#detail');
  if (!box) return;

  // 技能视图
  if (state.view === 'skills') {
    const k = (state.skillDetail && state.skillDetail.slug === state.skillSlug ? state.skillDetail : state.skills.find((x) => x.slug === state.skillSlug)) || state.skills[0];
    if (!k) {
      box.innerHTML = `<div class="phead"><div class="line1"><span class="ttl">技能</span></div>
        <p class="sub">可复用的操作手册：只把标题与关键词注入，需要全文就让它检索。</p></div>`;
      const bar0 = el('.actionbar');
      if (bar0) bar0.innerHTML = '';
      return;
    }
    box.innerHTML = skillDetailHtml(k);
    const bar = el('.actionbar');
    if (bar) {
      bar.innerHTML = `<button class="btn danger" data-act="delskill"><i data-ico="trash"></i>删掉这张技能卡</button>`;
      const del = bar.querySelector('[data-act="delskill"]');
      if (del) del.addEventListener('click', async () => {
        if (!confirm('删掉这张技能卡？条目与场景不受影响。')) return;
        await api('skill/delete', { method: 'POST', body: JSON.stringify({ slug: k.slug }) });
        state.skillSlug = '';
        await load();
      });
    }
    return;
  }

  // 可能重复：详情区只解释规则，合并按钮在每行
  if (state.view === 'dups') {
    box.innerHTML = `<div class="phead"><div class="line1"><span class="ttl">可能重复</span></div>
      <p class="sub">按向量相似度 ≥0.88 直接配对（不做连锁），每组挑一条「主条」保留。合并走「已被覆盖」，不删数据、随时能恢复。</p></div>`;
    const bar0 = el('.actionbar');
    if (bar0) bar0.innerHTML = '';
    return;
  }
  // 场景视图：整块换成四段正文
  if (state.view === 'scenes') {
    const s = (state.sceneDetail && state.sceneDetail.id === state.sceneId ? state.sceneDetail : state.scenes.find((x) => x.id === state.sceneId)) || state.scenes[0];
    if (!s) {
      box.innerHTML = `<div class="phead"><div class="line1"><span class="ttl">场景</span></div>
        <p class="sub">每次任务一段：目标 / 怎么做的 / 结果 / 留下的坑。会话蒸馏时自动切，不进注入。</p></div>`;
      const bar0 = el('.actionbar');
      if (bar0) bar0.innerHTML = '';
      return;
    }
    box.innerHTML = sceneDetailHtml(s);
    const bar = el('.actionbar');
    if (bar) {
      bar.innerHTML = `<button class="btn" data-act="delscene"><i data-ico="trash"></i>删掉这个场景</button>`;
      const del = bar.querySelector('[data-act="delscene"]');
      if (del) del.addEventListener('click', async () => {
        if (!confirm('删掉这个场景？只是这支记录，条目不受影响。')) return;
        await api('scene/delete', { method: 'POST', body: JSON.stringify({ id: s.id }) });
        state.sceneId = '';
        await load();
      });
      const tip = el('.actionbar .hint') || null;
      if (tip) tip.textContent = '';
    }
    return;
  }

  // 专题视图：整块换成一页正文
  if (state.view === 'pages') {
    const p = (state.pageDetail && state.pageDetail.slug === state.slug ? state.pageDetail : state.pages.find((x) => x.slug === state.slug)) || state.pages[0];
    if (!p) {
      box.innerHTML = `<div class="phead"><div class="line1"><span class="ttl">专题</span></div>
        <p class="sub">把同主题的几条记忆煮成一页，方便通读。在会话里说 /memory 煮页 主题，或在设置里煮。</p></div>`;
      const bar0 = el('.actionbar');
      if (bar0) bar0.innerHTML = '';
      return;
    }
    box.innerHTML = pageDetailHtml(p);
    els('[data-page]', box).forEach((b) => b.addEventListener('click', () => {
      state.slug = b.dataset.page; renderRows(); renderDetail();
    }));
    const bar = el('.actionbar');
    if (bar) {
      bar.innerHTML = `<button class="btn" data-act="recompose"><i data-ico="graph"></i>重新煮一遍</button>
        <button class="btn" data-act="delpage"><i data-ico="trash"></i>删掉这页</button>
        <span class="note">煮页只摘抄来源，不改原文</span>`;
      els('[data-act]', bar).forEach((b) => b.addEventListener('click', async () => {
        try {
          if (b.dataset.act === 'recompose') {
            const r = await api('page/compose', { method: 'POST', body: JSON.stringify({ topic: p.title }) });
            state.slug = r.page.slug;
            await load();
          } else if (confirm(`删掉「${p.title}」这一页？（来源条目不受影响）`)) {
            await api('page/delete', { method: 'POST', body: JSON.stringify({ slug: p.slug }) });
            state.slug = '';
            await load();
          }
        } catch (err) { alert(err.message); }
      }));
    }
    return;
  }

  // 编辑态：整块换成表单
  if (state.editing) {
    box.innerHTML = editorHtml();
    const bar = el('.actionbar');
    if (bar) {
      bar.innerHTML = `<button class="btn primary" data-act="save"><i data-ico="check"></i>保存</button>
        <button class="btn" data-act="cancel">取消</button>
        <span class="note">Ctrl+Enter 也能保存</span>`;
      els('[data-act]', bar).forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.act === 'save') saveEditor();
        else { state.editing = null; renderDetail(); }
      }));
    }
    el('#edScopeKind')?.addEventListener('change', (ev) => {
      const w = el('#edProjWrap');
      if (w) w.hidden = ev.target.value !== 'project';
      if (ev.target.value === 'project') el('#edProjPath')?.focus();
    });
    return;
  }

  const e = state.entries[state.sel];
  if (!e) { box.innerHTML = `<div class="head"><div class="idline"><span>没有选中的记忆</span></div></div>`; return; }
  const s = scopeLabel(e.scope);
  const pend = e.status === 'pending';
  const tags = (e.tags || []).join(' · ') || '—';
  box.innerHTML = `
    <div class="head">
      <div class="idline">
        <span class="num">#${esc(String(e.id).replace(/^0+/, ''))}</span>
        <span class="sep">·</span><span>${esc(STATUS[e.status] || e.status)}</span>
        <span class="sep">·</span><span>来自 ${esc(String(e.source?.created || e.created || '').slice(0, 10))} 的会话</span>
      </div>
      <h1>${esc(e.title)}</h1>
      <div class="pills">
        <span class="pill type">${esc(typeLabel(e.type))}</span>
        <span class="pill ${e.status === 'active' ? 'ok' : ''}">${esc(STATUS[e.status] || e.status)}</span>
        <span class="pill scope${s.proj ? ' proj' : ''}">${esc(s.text)}</span>
        ${e.priority >= 2 ? '<span class="pill warn">重要度 高</span>' : ''}
      </div>
    </div>
    ${supersedeHtml(e)}
    <div class="sect"><h2 class="sect-t">结论</h2><p>${esc(e.body)}</p></div>
    ${conflictHtml(e)}
    ${e.why ? `<div class="sect"><h2 class="sect-t">为什么</h2><p>${esc(e.why)}</p></div>` : ''}
    <div class="sect"><h2 class="sect-t">属性</h2>
      <dl class="props">
        <dt>标签</dt><dd>${esc(tags)}</dd>
        <dt>范围</dt><dd>${esc(s.proj ? s.text : '全局（所有会话都注入）')}</dd>
        <dt>创建</dt><dd>${esc(String(e.created || '').replace('T', ' ').slice(0, 16))}</dd>
        ${(e.rules || []).length ? `<dt>命中</dt><dd>${esc((e.rules || []).join('、'))}</dd>` : ''}
        <dt>文件</dt><dd class="mono"><span class="path"><i data-ico="folder"></i>${esc(e.file || '')}</span></dd>
      </dl>
    </div>`;
  const bar = el('.actionbar');
  if (bar) {
    const inTrash = state.view === 'trash';
    if (inTrash) {
      bar.innerHTML = `<button class="btn yes" data-act="restore"><i data-ico="check"></i>捞回来</button>
         <button class="btn danger" data-act="purge"><i data-ico="trash"></i>彻底删除</button>
         <span class="note">捞回会放回原来的位置，「彻底删除」删掉就找不回来了</span>`;
    } else if (pend) {
      bar.innerHTML = `<button class="btn yes" data-act="accept"><i data-ico="check"></i>收下</button>
         <button class="btn" data-act="edit"><i data-ico="pencil"></i>编辑</button>
         <button class="btn danger" data-act="discard"><i data-ico="x"></i>丢弃</button>
         <span class="note">确认后旧版存进 _trash/历史，可一键恢复</span>`;
    } else {
      const canSup = !e.superseded_by;
      bar.innerHTML = `<button class="btn" data-act="edit"><i data-ico="pencil"></i>编辑</button>
         ${canSup ? '<button class="btn" data-act="supersede"><i data-ico="check"></i>顶掉另一条…</button>' : ''}
         <button class="btn danger" data-act="discard"><i data-ico="x"></i>丢弃</button>
         <span class="note">${state.pickSupersede ? '点列表里的另一条，就用这条顶掉它（Esc 取消）' : ''}</span>`;
    }
    els('[data-act]', bar).forEach((b) => b.addEventListener('click', () => act(b.dataset.act, e)));
  }
  els('[data-cf]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api(`entry/${e.id}/conflict`, { method: 'POST', body: JSON.stringify({ choice: b.dataset.cf }) });
      await load();
    } catch (err) { alert(err.message); b.disabled = false; }
  }));
  els('[data-sup]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.sup === 'pick') {
      state.pickSupersede = state.pickSupersede === e.id ? '' : String(e.id);
      renderDetail(); renderRows();
      return;
    }
    b.disabled = true;
    try {
      if (b.dataset.sup === 'undo') {
        await api('entry/unsupersede', { method: 'POST', body: JSON.stringify({ id: e.id }) });
      } else if (b.dataset.sup === 'cancel-pick') {
        state.pickSupersede = '';
      }
      await load();
    } catch (err) { alert(err.message); b.disabled = false; }
  }));
}

/* 更正链：谁顶了谁、怎么反悔 */
function supersedeHtml(e) {
  if (e.status === 'superseded' && e.superseded_by) {
    return `<div class="supbox">
      <div class="t">这条已经被 #${esc(String(e.superseded_by).replace(/^0+/, ''))} 顶掉了</div>
      <div class="s">${esc(e.supersede_reason || '数值更新')}。旧条留着可追溯，不再参与注入。</div>
      <div class="acts"><button class="btn" data-sup="undo">反悔，恢复这条</button></div>
    </div>`;
  }
  if (e.supersedes) {
    return `<div class="supbox">
      <div class="t">这条顶替了 #${esc(String(e.supersedes).replace(/^0+/, ''))}</div>
      <div class="s">${esc(e.supersede_reason || '数值更新')}。要退回的话，去那条上点「反悔」。</div>
    </div>`;
  }
  if (state.pickSupersede && String(state.pickSupersede) === String(e.id)) {
    return `<div class="supbox">
      <div class="t">选另一条，用 #${esc(String(e.id).replace(/^0+/, ''))} 顶掉它</div>
      <div class="s">点列表里的目标条目即可。<button class="btn" data-sup="cancel-pick" style="margin-left:8px">取消</button></div>
    </div>`;
  }
  return '';
}

function paint() { renderRail(); renderHead(); renderChips(); renderRows(); renderDetail(); if (window.__dshIcons) window.__dshIcons(); }

/* ---------------- 动作 ---------------- */
async function act(kind, e) {
  if (!e) return;
  try {
    if (kind === 'accept') await api(`entry/${e.id}/accept`, { method: 'POST', body: '{}' });
    else if (kind === 'discard') {
      if (!confirm(`丢弃「${e.title}」？会进垃圾桶，能捞回来。`)) return;
      await api(`entry/${e.id}/discard`, { method: 'POST', body: '{}' });
    } else if (kind === 'edit') { openEditor(e); return; }
    else if (kind === 'supersede') {
      state.pickSupersede = String(e.id);
      renderDetail(); renderRows();
      return;
    }
    else if (kind === 'restore') {
      await api('trash/restore', { method: 'POST', body: JSON.stringify({ file: e.file }) });
    } else if (kind === 'purge') {
      if (!confirm(`「${e.title}」彻底删掉？这一步找不回来了。`)) return;
      await api('trash/purge', { method: 'POST', body: JSON.stringify({ file: e.file }) });
    }
    await load();
  } catch (err) { alert(err.message); }
}

/* ---------------- 数据 ---------------- */
async function load() {
  // 专题/场景/技能的数量：用全局统计，别等「进去过才有」
  try {
    const dg = await api('diag');
    state.lib = dg.diag?.library || {};
  } catch { /* 统计拿不到就退回列表长度 */ }
  if (state.view === 'skills') {
    const data = await api('skills');
    state.skills = data.skills || [];
    if (!state.skillSlug || !state.skills.some((s) => s.slug === state.skillSlug)) {
      state.skillSlug = state.skills[0]?.slug || '';
    }
    state.entries = [];
    state.sel = 0;
    await loadSkillDetail();
    paint();
    return;
  }
  if (state.view === 'dups') {
    const data = await api('duplicates');
    state.dups = data.groups || [];
    state.entries = [];
    state.sel = 0;
    paint();
    return;
  }
  if (state.view === 'scenes') {
    const data = await api('scenes');
    state.scenes = data.scenes || [];
    if (!state.sceneId || !state.scenes.some((s) => s.id === state.sceneId)) {
      state.sceneId = state.scenes[0]?.id || '';
    }
    state.entries = [];
    state.sel = 0;
    await loadSceneDetail();
    paint();
    return;
  }
  if (state.view === 'pages') {
    const data = await api('pages');
    state.pages = data.pages || [];
    if (!state.slug || !state.pages.some((p) => p.slug === state.slug)) {
      state.slug = state.pages[0]?.slug || '';
    }
    state.entries = [];
    state.sel = 0;
    await loadPageDetail();
    paint();
    return;
  }
  const qs = new URLSearchParams({ view: state.view });
  if (state.q) qs.set('q', state.q);
  const data = await api(`list?${qs}`);
  state.entries = data.entries || [];
  state.counts = data.counts || null;
  state.meta = data.meta || null;
  if (state.sel >= state.entries.length) state.sel = Math.max(0, state.entries.length - 1);
  paint();
}

/* ---------------- 设置抽屉 ---------------- */
function openDrawer(open) {
  const d = el('#settings'); const scrim = el('#scrim'); const btn = el('#openSettings');
  if (!d) return;
  d.classList.toggle('on', open);
  d.setAttribute('aria-hidden', String(!open));
  if (scrim) scrim.classList.toggle('on', open);
  if (btn) btn.setAttribute('aria-expanded', String(open));
}

const WM_TEXT = {
  manual: '手动：只有你亲口说「记住」或我主动写时才入库，平时不自动记',
  semi: '半自动：给你候选，你确认后才入库',
  auto: '自动：我判断值得记的直接入库，事后可在「待确认箱」翻看',
};

// 三档的选中态与下面那句说明，必须一起跟着走
function paintWriteMode(v) {
  const wm = el('#writeModeSeg');
  if (wm) els('button', wm).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === v)));
  const note = el('#writeModeNote');
  if (note) note.textContent = WM_TEXT[v] || WM_TEXT.semi;
}

function paintPort(cfg) {
  const fixed = Number(cfg?.panel?.fixedPort || 0);
  const inp = el('#portInput');
  if (inp && document.activeElement !== inp) inp.value = fixed > 0 ? String(fixed) : '';
  const now = el('#portNow');
  if (now) {
    const st = state.portStatus || {};
    let base = fixed > 0
      ? `http://127.0.0.1:${fixed}/dsh-memory/` + (location.port === String(fixed) ? '' : '（重启后生效）')
      : (/^https?:/.test(location.protocol) ? `${location.origin}/dsh-memory/` : '跟随 DSH 端口（每启动一次会变）');
    if (fixed > 0 && st.error) base += `（${st.error}，换个端口试试）`;
    now.textContent = base;
  }
}

/* 问服务端这个端口能不能绑：返回 {ok, error} */
async function checkPort(port) {
  try {
    const r = await api(`port?p=${encodeURIComponent(port)}`);
    return { ok: Boolean(r.ok), error: r.error || '' };
  } catch (e) {
    return { ok: false, error: e?.message || '检测失败' };
  }
}

function setPortNote(text, bad) {
  const note = el('#portNote');
  if (!note) return;
  note.textContent = text;
  note.style.color = bad ? '#c0392b' : '';
}

async function savePort(v) {
  const raw = String(v ?? '').trim();
  const fixedPort = raw === '' ? 0 : Number(raw);
  if (raw !== '' && (!Number.isInteger(fixedPort) || fixedPort < 1024 || fixedPort > 65535)) {
    setPortNote('端口要填 1024–65535 之间的整数', true);
    return;
  }
  if (fixedPort > 0) {
    setPortNote(`正在检查 ${fixedPort}…`);
    const chk = await checkPort(fixedPort);
    if (!chk.ok) {
      setPortNote(`${fixedPort} ${chk.error || '不可用'}，换一个再试`, true);
      return;
    }
  }
  try {
    await api('config', { method: 'POST', body: JSON.stringify({ panel: { fixedPort } }) });
    if (state.config) state.config.panel = { ...(state.config.panel || {}), fixedPort };
    paintPort(state.config);
    setPortNote(fixedPort
      ? `已设为固定 ${fixedPort}：重启一次 DSH 后，用 http://127.0.0.1:${fixedPort}/dsh-memory/ 打开`
      : '已改回跟随 DSH 端口：重启一次 DSH 后生效');
  } catch (e) {
    setPortNote(`保存失败：${e?.message || e}`, true);
  }
}

async function loadConfig() {
  try {
    const data = await api('config');
    const config = data.config || {};
    state.config = config;
    state.portStatus = data.portStatus || {};
    state.root = data.root || config.root || '';
    state.defaultRoot = data.defaultRoot || '';
    paintPort(config);
    paintWriteMode(config.writeMode);
    paintRoot(state.root, data.entries ?? state.meta?.entries ?? 0);
    if (window.__dshIcons) window.__dshIcons();
  } catch { /* 未登录或接口缺失时静默 */ }
  loadPersona();
}

/* 关于你：身份层，单独一份文件，不占记忆条数预算 */
async function loadPersona() {
  try {
    const data = await api('persona');
    const p = data.persona || {};
    const set = (id, v) => { const n = el(id); if (n && document.activeElement !== n) n.value = v || ''; };
    set('#psCall', p.call);
    set('#psLang', p.lang);
    set('#psStyle', p.style);
    set('#psBounds', (p.boundaries || []).join('\n'));
    const note = el('#psNote');
    if (note) note.textContent = data.empty ? '' : '已生效，改完按保存';
    paintPersonaSummary(p, !!data.empty);
    loadSuggestions();
  } catch { /* 旧版插件没有这个接口时静默 */ }
}

async function loadSuggestions() {
  const box = el('#sugRows');
  if (!box) return;
  try {
    const data = await api('suggestions');
    const items = data.items || [];
    box.innerHTML = items.length
      ? items.map((s) => `<div class="sugrow" data-sug="${esc(s.id)}">
          <div class="v">${s.field === 'style' ? '说话风格' : '硬规则'}：${esc(s.value)}</div>
          <div class="r">${esc(s.reason || '')} · 来源 ${(s.sources || []).join('、')}</div>
          <div class="acts"><button class="btn small primary" data-sug-act="accept" data-id="${esc(s.id)}">采纳</button>
            <button class="btn small" data-sug-act="dismiss" data-id="${esc(s.id)}">忽略</button></div>
        </div>`).join('')
      : '<div class="hint">暂时没有建议。多干几件事、或者点「重新找一遍」。</div>';
    const badge = el('#sugBadge');
    if (badge) { badge.hidden = !items.length; badge.textContent = items.length + ' 条建议'; }
    const note = el('#sugNote');
    if (note) note.textContent = items.length ? `${items.length} 条候选，采纳才写进上面` : '从最近的记忆里看出来的，采纳才写进上面';
  } catch {
    box.innerHTML = '<div class="hint">读不到建议（插件可能还是旧代码，重启一次 DSH）</div>';
  }
}

async function sugAct(kind, id) {
  try {
    await api(`suggestion/${kind === 'accept' ? 'accept' : 'dismiss'}`, { method: 'POST', body: JSON.stringify({ id }) });
    if (kind === 'accept') { const d = await api('persona'); if (d && d.persona) paintPersonaSummary(d.persona, !!d.empty); }
    await loadSuggestions();
  } catch (e) {
    const note = el('#sugNote');
    if (note) note.textContent = `操作失败：${e.message}`;
  }
}

async function refreshSuggestions() {
  const note = el('#sugNote');
  if (note) note.textContent = '正在找…';
  try {
    await api('suggestions/refresh', { method: 'POST', body: '{}' });
    await loadSuggestions();
  } catch (e) {
    if (note) note.textContent = `失败：${e.message}`;
  }
}

/* 折叠状态：默认收起，只留一行摘要；记在 localStorage 里 */
function paintPersonaSummary(p, empty) {
  const sum = el('#personaSum');
  if (!sum) return;
  const bits = [];
  if (p.call) bits.push(`称呼：${p.call}`);
  if (p.lang) bits.push(p.lang);
  if (p.style) bits.push(`风格：${p.style}`);
  const n = (p.boundaries || []).length;
  if (n) bits.push(`${n} 条原则`);
  sum.textContent = empty || !bits.length
    ? '还没填'
    : bits.join(' ｜ ');
}

function togglePersona(open) {
  const disc = el('#personaDisc');
  const body = el('#personaBody');
  if (!disc || !body) return;
  const next = typeof open === 'boolean' ? open : body.hidden;
  body.hidden = !next;
  disc.setAttribute('aria-expanded', next ? 'true' : 'false');
  disc.classList.toggle('open', next);
  try { localStorage.setItem('mem-persona-open', next ? '1' : '0'); } catch {}
}

async function savePersona() {
  const btn = el('#psSave');
  const note = el('#psNote');
  if (btn) btn.disabled = true;
  if (note) note.textContent = '保存中…';
  try {
    const body = {
      call: el('#psCall')?.value || '',
      lang: el('#psLang')?.value || '',
      style: el('#psStyle')?.value || '',
      boundaries: (el('#psBounds')?.value || '').split('\n').map((s) => s.trim()).filter(Boolean),
    };
    const data = await api('persona', { method: 'POST', body: JSON.stringify(body) });
    if (!data || !data.persona) throw new Error('插件还在跑旧代码，重启一次 DSH 桌面端');
    if (note) note.textContent = '已保存，下一轮生效';
    paintPersonaSummary(data.persona, false);
    loadSuggestions();
  } catch (err) {
    if (note) note.textContent = `没存上：${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* 记忆库位置：显示解析后的真实目录，可改 */
function paintRoot(dir, entries) {
  const input = el('#rootPath');
  if (input && document.activeElement !== input) input.value = dir || '';
  const n = el('#rootCount');
  if (n) n.textContent = `${entries} 条`;
}

function setMaintNote(text, bad) {
  const n = el('#maintNote');
  if (!n) return;
  n.textContent = text;
  n.style.color = bad ? 'var(--danger, #c0392b)' : 'var(--fg-3)';
}

/* ---------- 运行状态（.diag.json） ---------- */

const DOT_COLOR = { green: '#2ecc71', amber: '#e0a800', red: '#e74c3c' };
const DOT_WORD = { green: '正常', amber: '很久没抓到东西', red: '有报错' };

function relTime(at) {
  if (!at) return '还没跑过';
  const t = Date.parse(String(at).replace(' ', 'T'));
  if (!Number.isFinite(t)) return at;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/* ---------------- 向量（4D） ---------------- */
async function loadVector() {
  const note = el('#vecNote');
  const seg = el('#vecSeg');
  try {
    const r = await api('vector');
    const v = r.vector || {};
    if (seg) {
      els('button', seg).forEach((b) => {
        const on = String(b.dataset.v) === '1';
        b.setAttribute('aria-pressed', on === (v.enabled !== false) ? 'true' : 'false');
      });
    }
    if (note) {
      note.textContent = v.enabled === false
        ? '关掉了，只用关键词匹配'
        : `${v.text || ''}${v.built < v.total ? '（还有 ' + (v.total - v.built) + ' 条没算，点「建一次」）' : ''}`;
    }
  } catch {
    if (note) note.textContent = '读不到向量状态（插件可能还是旧代码，重启一次 DSH）';
  }
}

async function setVector(on) {
  const note = el('#vecNote');
  if (note) note.textContent = '保存中…';
  try {
    await api('config', { method: 'POST', body: JSON.stringify({ vector: { enabled: !!on } }) });
    await loadVector();
  } catch (err) {
    if (note) note.textContent = `没存上：${err.message}`;
  }
}

async function buildVector() {
  const btn = el('#btnVector');
  const note = el('#vecNote');
  if (btn) btn.disabled = true;
  if (note) note.textContent = '正在算…（第一次会先加载模型，几秒到十几秒）';
  try {
    const r = await api('vector/build', { method: 'POST' });
    if (note) note.textContent = `刚补了 ${r.embedded} 条。${r.vector?.text || ''}`;
  } catch (err) {
    if (note) note.textContent = `没建成：${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadDiag() {
  const box = el('#diagRows');
  let d = null;
  try { const r = await api('diag'); d = r.diag; } catch { d = null; }
  // 顺手把向量状态也刷一下（同一个抽屉里）
  loadVector();
  if (!d) { if (box) box.textContent = '读不到运行状态（插件可能还是旧代码，重启一次 DSH）'; return; }
  const lib = d.library || {};
  const rows = [
    ['抓取', relTime(d.capture?.at)],
    ['维护', relTime(d.maintain?.at)],
    ['索引', relTime(d.reindex?.at)],
    ['会话/场景', `${lib.sessions} / ${lib.scenes}`],
    ['技能/专题', `${lib.skills} / ${lib.pages}`],
    ['向量', d.vector ? String(d.vector.built || 0) + '/' + String(d.vector.total || 0) + ' 条' : '—'],
    ['健康', DOT_WORD[d.health] || d.health || '未知'],
  ];
  if (box) {
    box.innerHTML = rows.map(([k, v]) => `<div class="diagrow"><span>${k}</span><b>${v}</b></div>`).join('');
  }
  const dot = el('#diagDot');
  if (dot) {
    dot.style.background = DOT_COLOR[d.health] || 'var(--fg-3)';
    dot.title = `运行状态：${DOT_WORD[d.health] || d.health || '未知'}`;
    dot.hidden = false;
  }
}

function setRootNote(text, bad) {
  const note = el('#rootNote');
  if (!note) return;
  note.textContent = text;
  note.style.color = bad ? 'var(--danger, #c0392b)' : '';
}

async function saveRoot(value) {
  const btn = el('#rootSave');
  if (btn) btn.disabled = true;
  setRootNote('正在搬…');
  try {
    const data = await api('config', { method: 'POST', body: JSON.stringify({ root: value }) });
    if (!data || !data.root) {
      // 插件本体（lib/*.js）是启动时加载的，没重启就还是旧代码，这时接口不会回 root
      setRootNote('插件还在跑旧代码：重启一次 DSH 桌面端，这个按钮才真的能换位置（面板本身刷新就够）', true);
      return;
    }
    state.root = data.root;
    state.config = data.config;
    paintRoot(data.root, data.entries);
    if (data.moved && data.moved.changed) {
      const n = data.moved.copied;
      setRootNote(n ? `已改到 ${data.root}，复制过来 ${n} 个文件；旧文件夹没动，随时能改回去` : `已改到 ${data.root}（这个文件夹本来是空的）`);
    } else {
      setRootNote(`已经在用 ${data.root} 了`);
    }
    await load();
  } catch (err) {
    setRootNote(`没改成：${err.message}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------------- 项目实体 + 专题（4C） ---------------- */

function setProjNote(text, bad) {
  const n = el('#projNote');
  if (!n) return;
  n.textContent = text || '';
  n.style.color = bad ? 'var(--danger, #c0392b)' : 'var(--fg-3)';
}

async function loadProjects() {
  const box = el('#projRows');
  if (!box) return;
  try {
    const data = await api('projects');
    state.projects = data.projects || [];
  } catch {
    state.projects = [];
  }
  if (!state.projects.length) {
    box.innerHTML = '<div class="hint">还没有项目。在某个文件夹里记一条「只在这个项目」的记忆，就会自动建一个。</div>';
    setProjNote('');
    return;
  }
  box.innerHTML = state.projects.map((p) => `<div class="projrow" data-id="${esc(p.id)}">
      <span class="nm">${esc(p.name)} <span class="ct">（${p.id}）</span></span>
      <span class="ct">${p.active}/${p.count} 条</span>
      <button data-op="rename" title="改名">改名</button>
      <button data-op="addpath" title="加一个文件夹">加路径</button>
      <button data-op="delete" title="删掉这个项目">删</button>
    </div>`).join('');
  els('[data-op]', box).forEach((b) => b.addEventListener('click', async () => {
    const id = b.closest('.projrow')?.dataset.id;
    const p = state.projects.find((x) => x.id === id);
    if (!p) return;
    try {
      if (b.dataset.op === 'rename') {
        const name = prompt('项目叫什么？', p.name);
        if (!name) return;
        await api('project/rename', { method: 'POST', body: JSON.stringify({ id, name }) });
      } else if (b.dataset.op === 'addpath') {
        const dir = prompt('再加一个文件夹（绝对路径）', p.paths[0] || '');
        if (!dir) return;
        await api('project/path', { method: 'POST', body: JSON.stringify({ id, dir }) });
      } else if (b.dataset.op === 'delete') {
        if (!confirm(`删掉项目「${p.name}」？（只删这个分组，条目不受影响）`)) return;
        await api('project/delete', { method: 'POST', body: JSON.stringify({ id }) });
      }
      await loadProjects();
      await load();
    } catch (err) { setProjNote(err.message, true); }
  }));
  const total = state.projects.reduce((n, p) => n + (p.count || 0), 0);
  setProjNote(`${state.projects.length} 个项目，挂着 ${total} 条记忆；路径里的子文件夹也算同一个项目`);
}

async function composePage() {
  const input = el('#pageTopic');
  const note = el('#pageNote');
  const topic = (input?.value || '').trim();
  if (!topic) { if (note) note.textContent = '先写个主题，例如 pnpm'; return; }
  if (note) note.textContent = '正在煮…';
  try {
    const data = await api('page/compose', { method: 'POST', body: JSON.stringify({ topic }) });
    const page = data.page;
    if (note) note.textContent = `煮好了：${page.title}（${page.sourceCount} 条来源）`;
    state.view = 'pages'; state.slug = page.slug;
    await load();
  } catch (err) {
    if (note) note.textContent = `没煮成：${err.message}`;
  }
}

/* ---------------- 绑定 ---------------- */
function bind() {
  if (ui.search) {
    let timer = 0;
    ui.search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { state.q = ui.search.value.trim(); state.sel = 0; load().catch((e) => alert(e.message)); }, 220);
    });
  }
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      // 编辑器里：Ctrl+Enter 保存、Esc 退出表单（先 blur 掉输入框）
      if (state.editing && (e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveEditor(); return; }
      if (state.editing && e.key === 'Escape') { e.preventDefault(); state.editing = null; renderDetail(); return; }
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (state.editing) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveEditor(); }
      else if (e.key === 'Escape') { state.editing = null; renderDetail(); }
      return;
    }
    if (state.pickSupersede && e.key === 'Escape') {
      state.pickSupersede = ''; renderRows(); renderDetail(); return;
    }
    if (e.key === 'j' || e.key === 'J') { state.sel = Math.min(state.entries.length - 1, state.sel + 1); renderRows(); renderDetail(); }
    else if (e.key === 'k' || e.key === 'K') { state.sel = Math.max(0, state.sel - 1); renderRows(); renderDetail(); }
    else if (e.key === 'Enter') { const cur = state.entries[state.sel]; if (cur?.status === 'pending') act('accept', cur); }
    else if (e.key === 'Delete') { const cur = state.entries[state.sel]; if (cur) act('discard', cur); }
    else if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); openDrawer(!el('#settings')?.classList.contains('on')); }
  });
  const all = el('.listhead .acts');
  if (all) {
    const [acceptAll, dropAll] = els('button', all);
    acceptAll?.addEventListener('click', async () => {
      if (!state.entries.length || !confirm(`把这 ${state.entries.length} 条全部收下？`)) return;
      for (const e of state.entries.slice()) await api(`entry/${e.id}/accept`, { method: 'POST', body: '{}' }).catch(() => {});
      await load();
    });
    dropAll?.addEventListener('click', async () => {
      if (!state.entries.length || !confirm(`把这 ${state.entries.length} 条全部丢弃？`)) return;
      for (const e of state.entries.slice()) await api(`entry/${e.id}/discard`, { method: 'POST', body: '{}' }).catch(() => {});
      await load();
    });
  }
  // 「地址」= 跟随 DSH 端口 / 固定到任意端口（改完要重启 DSH 才起新监听）
  el('#portSave')?.addEventListener('click', () => savePort(el('#portInput')?.value ?? ''));
  el('#portFollow')?.addEventListener('click', () => { const i = el('#portInput'); if (i) i.value = ''; savePort(''); });
  el('#portInput')?.addEventListener('input', async () => {
    const v = String(el('#portInput')?.value ?? '').trim();
    if (!v) { setPortNote('跟随 DSH 端口：每启动一次地址会变'); return; }
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) { setPortNote('端口要填 1024–65535 之间的整数', true); return; }
    const chk = await checkPort(n);
    setPortNote(chk.ok ? `${n} 可用，点「固定到这儿」保存（重启后生效）` : `${n} ${chk.error}`, !chk.ok);
  });
  // 「记多少」= 写入口径，落进 config.json（manual 不自动抓 / semi 只进待确认箱 / auto 直接生效）
  const wm = el('#writeModeSeg');
  if (wm) {
    els('button', wm).forEach((b) => b.addEventListener('click', async () => {
      const v = b.dataset.v;
      paintWriteMode(v);
      try {
        const r = await api('config', { method: 'POST', body: JSON.stringify({ writeMode: v }) });
        if (r && r.config) state.config = r.config;
      } catch (err) { alert(err.message); loadConfig(); }
    }));
  }
  // 「记忆库位置」= 换文件夹；默认把现有 .md 复制过去，旧的不删
  const rootSave = el('#rootSave');
  if (rootSave) {
    rootSave.addEventListener('click', () => saveRoot(el('#rootPath')?.value?.trim() || ''));
  }
  const rootInput = el('#rootPath');
  if (rootInput) {
    rootInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveRoot(rootInput.value.trim()); } });
  }
  // 维护 / 撤销自动写入
  const maintBtn = el('#btnMaintain');
  if (maintBtn) {
    maintBtn.addEventListener('click', async () => {
      maintBtn.disabled = true;
      setMaintNote('正在清理…');
      try {
        const r = await api('maintain', { method: 'POST', body: '{}' });
        setMaintNote(r.summary || '完成');
        await load();
      } catch (err) { setMaintNote(`失败：${err.message}`, true); }
      finally { maintBtn.disabled = false; }
    });
  }
  const undoBtn = el('#btnUndo');
  if (undoBtn) {
    undoBtn.addEventListener('click', async () => {
      undoBtn.disabled = true;
      try {
        const r = await api('undo', { method: 'POST', body: JSON.stringify({ n: 1 }) });
        const list = r.undone || [];
        setMaintNote(list.length ? `已撤回：${list.map((x) => `#${x.id} ${x.title}`).join('、')}` : '没有可撤回的自动写入');
        await load();
      } catch (err) { setMaintNote(`失败：${err.message}`, true); }
      finally { undoBtn.disabled = false; }
    });
  }
  const rootDefault = el('#rootDefault');
  if (rootDefault) {
    rootDefault.addEventListener('click', () => saveRoot(''));
  }
  loadDiag();
  loadProjects();
  el('#btnNormalize')?.addEventListener('click', async () => {
    if (!confirm('把老条目里的「project:路径」范围统一改成项目 id？会改写这些条目的 scope 字段（正文不动）。')) return;
    try {
      const r = await api('project/normalize', { method: 'POST', body: '{}' });
      setProjNote(`规整完成：改了 ${r.changed} 条，新建 ${r.created} 个项目`);
      await loadProjects();
      await load();
    } catch (err) { setProjNote(`失败：${err.message}`, true); }
  });
  el('#btnComposePage')?.addEventListener('click', () => composePage());
  el('#pageTopic')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') composePage(); });
  el('#vecSeg')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) setVector(b.dataset.v === '1');
  });
  el('#btnVector')?.addEventListener('click', () => buildVector());
  const add = el('.topbar .btn.primary');
  add?.addEventListener('click', () => openEditor(null));
  const psSave = el('#psSave');
  psSave?.addEventListener('click', () => savePersona());
  el('#sugRefresh')?.addEventListener('click', () => refreshSuggestions());
  el('#sugRows')?.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-sug-act]');
    if (!b) return;
    sugAct(b.dataset.sugAct, b.dataset.id);
  });
  const psDisc = el('#personaDisc');
  if (psDisc) {
    psDisc.addEventListener('click', () => togglePersona());
    try { if (localStorage.getItem('mem-persona-open') === '1') togglePersona(true); } catch {}
  }
  const reindex = els('.drawer .fld button').find((b) => b.textContent.trim() === '重建');
  reindex?.addEventListener('click', async () => {
    try { const r = await api('reindex', { method: 'POST', body: '{}' }); alert(`索引已重建：${r.docs} 条`); }
    catch (err) { alert(err.message); }
  });
}

(async function main() {
  bind();
  try {
    await load();
    await loadConfig();
  } catch (err) {
    el('#rows').innerHTML = `<div class="row"><div class="line1"><span class="ttl">读不到记忆库</span></div><p class="sub">${esc(err.message)}</p></div>`;
  }
})();
