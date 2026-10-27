/* 面板的 HTTP 边：4 组 API + 静态页 + 登录闸门。
   不依赖任何框架——DSH 给什么 server 我们就挂一个 (req,res) 上去。 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { defaultRoot } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = path.join(HERE, '..', 'panel');
const STATIC = new Set(['index.html', 'app.js', 'style.css', 'icons.js', 'theme.js', 'login.html']);
/** 登录之前也要能取到的静态文件（登录页自己的皮）。 */
const PUBLIC = new Set(['login.html', 'style.css', 'icons.js']);

const COOKIE = 'mem_sid';
const SESSION_HOURS = 12;
const LOCK_MS = 60 * 1000;
const MAX_FAILS = 5;

function json(res, code, body) {
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(buf);
}

function file(res, name) {
  const full = path.join(PANEL_DIR, path.basename(name));
  if (!STATIC.has(path.basename(name)) || !fs.existsSync(full)) { json(res, 404, { ok: false, error: '没有这个文件' }); return; }
  const type = full.endsWith('.js') ? 'text/javascript; charset=utf-8'
    : full.endsWith('.css') ? 'text/css; charset=utf-8'
      : 'text/html; charset=utf-8';
  const buf = fs.readFileSync(full);
  res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(buf);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体太大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('请求体不是 JSON')); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function portFree(port) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      resolve({ ok: false, error: '端口要填 1024–65535 之间的整数' });
      return;
    }
    const srv = net.createServer();
    srv.unref();
    srv.once('error', (e) => resolve({ ok: false, error: e.code === 'EADDRINUSE' ? '已被占用' : (e.message || String(e)) }));
    srv.once('listening', () => srv.close(() => resolve({ ok: true })));
    srv.listen(port, '127.0.0.1');
  });
}

export function createPanel({ service, log = () => {}, basePath = '/dsh-memory', initialPassword = '', hooks = {} } = {}) {
  // 仓库位置可以被用户改（service.switchRoot），所以口令文件路径要按需取值
  const rootOf = () => service.root;
  const authPath = () => path.join(rootOf(), '.panel-auth.json');
  const fails = { count: 0, until: 0 };

  /* ---------- 口令 ---------- */
  function readAuth() {
    try { return JSON.parse(fs.readFileSync(authPath(), 'utf8')); } catch { return null; }
  }

  function writeAuth(auth) {
    fs.mkdirSync(rootOf(), { recursive: true });
    fs.writeFileSync(authPath(), `${JSON.stringify(auth, null, 2)}\n`, 'utf8');
    try { fs.chmodSync(authPath(), 0o600); } catch { /* Windows 上靠 ACL，这里失败就算了 */ }
  }

  function hash(password, salt) { return scryptSync(password, salt, 64).toString('hex'); }

  function ensureAuth() {
    const cfg = service.config();
    const existing = readAuth();
    if (existing && existing.hash && existing.salt) return existing;
    const password = initialPassword || randomBytes(9).toString('base64url');
    const salt = randomBytes(16).toString('hex');
    const auth = {
      version: 1, user: cfg.panel?.user || 'owner', salt, hash: hash(password, salt),
      secret: randomBytes(32).toString('hex'), updated: new Date().toISOString(),
    };
    writeAuth(auth);
    log(`已生成面板口令：账号 ${auth.user} / 密码 ${password}（只显示这一次，记进密码管理器）`);
    return auth;
  }

  /** 换锁：重新生成随机口令，不动记忆文件。返回明文供命令回显一次。 */
  function resetPassword() {
    const cfg = service.config();
    const old = readAuth();
    const password = randomBytes(9).toString('base64url');
    const salt = randomBytes(16).toString('hex');
    const auth = {
      version: 1,
      user: old?.user || cfg.panel?.user || 'owner',
      salt,
      hash: hash(password, salt),
      secret: randomBytes(32).toString('hex'),
      updated: new Date().toISOString(),
    };
    writeAuth(auth);
    fails.count = 0;
    fails.until = 0;
    log('面板口令已重置');
    return password;
  }

  function sign(auth, exp) { return createHmac('sha256', auth.secret).update(String(exp)).digest('base64url'); }

  function issue(res, auth) {
    const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
    const value = `${exp}.${sign(auth, exp)}`;
    res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`);
  }

  function authed(req) {
    const cfg = service.config();
    if (cfg.panel?.requireAuth === false) return true;
    const a = readAuth();
    if (!a) return false;
    const raw = cookies(req)[COOKIE];
    if (!raw) return false;
    const [exp, sig] = String(raw).split('.');
    if (!exp || !sig) return false;
    if (Number(exp) < Date.now()) return false;
    const want = sign(a, exp);
    try { return timingSafeEqual(Buffer.from(sig), Buffer.from(want)); } catch { return false; }
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;                       // 同源 fetch 有时不带 origin
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  function verify(auth, user, password) {
    if (String(user || '') !== String(auth.user || '')) return false;
    const got = Buffer.from(hash(String(password || ''), auth.salt), 'hex');
    const want = Buffer.from(auth.hash, 'hex');
    if (got.length !== want.length) return false;
    return timingSafeEqual(got, want);
  }

  /* ---------- 路由 ---------- */
  async function api(req, res, url) {
    const p = url.pathname.slice(basePath.length);
    const method = req.method || 'GET';
    const s = service;

    if (p === '/api/ping') return json(res, 200, { ok: true, authed: authed(req) });

    if (p === '/api/login' && method === 'POST') {
      if (Date.now() < fails.until) {
        const left = Math.ceil((fails.until - Date.now()) / 1000);
        return json(res, 429, { ok: false, error: `连错次数太多，等 ${left} 秒再试` });
      }
      const auth = ensureAuth();
      const body = await readBody(req);
      if (!verify(auth, body.user ?? auth.user, body.password)) {
        fails.count += 1;
        if (fails.count >= MAX_FAILS) { fails.until = Date.now() + LOCK_MS; fails.count = 0; }
        log(`面板登录失败（${body.user ?? '?'}）`);
        return json(res, 401, { ok: false, error: '账号或密码不对' });
      }
      fails.count = 0;
      issue(res, auth);
      log('面板登录成功');
      return json(res, 200, { ok: true });
    }

    if (p === '/api/logout' && method === 'POST') {
      res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      return json(res, 200, { ok: true });
    }

    if (!authed(req)) return json(res, 401, { ok: false, error: '未登录' });

    if (method !== 'GET' && !sameOrigin(req)) return json(res, 403, { ok: false, error: '来源不对' });

    if (p === '/api/list' && method === 'GET') {
      const view = url.searchParams.get('view') || 'pending';
      const q = url.searchParams.get('q') || '';
      return json(res, 200, { ok: true, ...s.list({ view, q }) });
    }

    if (p === '/api/port' && method === 'GET') {
      const want = Number(url.searchParams.get('p') || 0);
      const r = await portFree(want);
      return json(res, 200, { ok: r.ok, port: want, error: r.error || '' });
    }
    if (p === '/api/config' && method === 'GET') {
      return json(res, 200, {
        ok: true,
        config: s.config(),
        root: s.root,
        defaultRoot: defaultRoot(),
        entries: s.counts().all,
        portStatus: typeof hooks.portStatus === 'function' ? hooks.portStatus() : null,
      });
    }
    if (p === '/api/config' && method === 'POST') {
      const body = (await readBody(req)) || {};
      if (body.panel && Object.prototype.hasOwnProperty.call(body.panel, 'fixedPort')) {
        const raw = body.panel.fixedPort;
        const n = Number(raw);
        const okZero = n === 0 || raw === '' || raw === null || raw === undefined;
        if (!okZero && (!Number.isInteger(n) || n < 1024 || n > 65535)) {
          return json(res, 400, { ok: false, error: '端口要填 1024–65535 之间的整数' });
        }
        if (!okZero) {
          const chk = await portFree(n);
          if (!chk.ok) return json(res, 409, { ok: false, error: `${n} ${chk.error}` });
        }
        body.panel.fixedPort = okZero ? 0 : n;
      }
      // 换记忆库位置：只认绝对路径；默认把现有 .md 复制过去，不删旧的
      if (Object.prototype.hasOwnProperty.call(body, 'root')) {
        const want = String(body.root || '').trim();
        const current = s.config();
        if (want && path.resolve(want) === path.resolve(s.root)) {
          return json(res, 200, { ok: true, config: current, root: s.root, defaultRoot: defaultRoot(), entries: s.counts().all, moved: null });
        }
        try {
          const keepAuth = readAuth();
          const moved = s.switchRoot(want || defaultRoot(), { copy: body.copy !== false });
          // 口令跟着仓库走：新仓库没有口令文件时，把现在的这份带过去，免得马上被踢回登录页
          if (keepAuth && !fs.existsSync(authPath())) writeAuth(keepAuth);
          else if (!fs.existsSync(authPath())) ensureAuth();
          return json(res, 200, {
            ok: true, config: s.config(), root: s.root, defaultRoot: defaultRoot(),
            entries: s.counts().all, moved,
          });
        } catch (err) {
          return json(res, 400, { ok: false, error: err.message });
        }
      }
      return json(res, 200, { ok: true, config: s.setConfig(body), root: s.root, defaultRoot: defaultRoot() });
    }

    if (p === '/api/reindex' && method === 'POST') return json(res, 200, { ok: true, ...s.reindex() });

    if (p === '/api/distill' && method === 'GET') {
      const q = typeof hooks.queueInfo === 'function' ? hooks.queueInfo() : { queued: 0 }
      return json(res, 200, { ok: true, ...q, last: s.diag()?.distill || null, writeMode: s.config()?.writeMode || 'semi' })
    }
    if (p === '/api/distill' && method === 'POST') {
      const body = await readBody(req)
      if (typeof hooks.distill !== 'function') return json(res, 500, { ok: false, error: '插件不支持蒸馏' })
      const limit = Math.max(1, Math.min(20, Number(body?.limit) || 3))
      try {
        const r = await hooks.distill({ limit })
        return json(res, 200, { ok: true, ...r, queue: hooks.queueInfo?.() || {} })
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error?.message || error) })
      }
    }
    if (p === '/api/vector' && method === 'GET') return json(res, 200, { ok: true, vector: s.vectorStatus() });
    if (p === '/api/vector/build' && method === 'POST') {
      const r = await s.embedAll();
      return json(res, r.ok ? 200 : 500, { ok: !!r.ok, ...r, vector: s.vectorStatus() });
    }

    if (p === '/api/persona' && method === 'GET') {
      return json(res, 200, { ok: true, ...s.personaPreview() });
    }
    if (p === '/api/persona' && method === 'POST') {
      try {
        return json(res, 200, { ok: true, persona: s.setPersona(await readBody(req)) });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }

    // 可能重复：只列候选，合并要人点（合并走 supersede，可恢复）
    if (p === '/api/duplicates' && method === 'GET') {
      try {
        const r = await s.findDuplicates({ threshold: Number(url.searchParams.get('t') || 0.88) });
        return json(res, 200, { ok: true, ...r });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }
    if (p === '/api/duplicates/merge' && method === 'POST') {
      try {
        const b = await readBody(req);
        return json(res, 200, { ok: true, ...(await s.mergeDuplicates(b.keep, b.others || [], b.reason)) });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }
    // 4E-6 画像建议：只给候选，采纳才写进 persona.md
    if (p === '/api/suggestions' && method === 'GET') {
      return json(res, 200, { ok: true, ...s.suggestions() });
    }
    if (p === '/api/suggestions/refresh' && method === 'POST') {
      return json(res, 200, { ok: true, ...s.refreshSugg() });
    }
    if (p === '/api/suggestion/accept' && method === 'POST') {
      try {
        const b = await readBody(req);
        return json(res, 200, { ok: true, ...s.acceptSuggestion(String(b.id || '')) });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }
    if (p === '/api/suggestion/dismiss' && method === 'POST') {
      try {
        const b = await readBody(req);
        return json(res, 200, { ok: true, ...s.dismissSuggestion(String(b.id || '')) });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }

    if (p === '/api/entry/new' && method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, { ok: true, entry: s.create(body) });
    }

    const m = p.match(/^\/api\/entry\/([0-9]{1,9})\/(accept|discard|edit|conflict)$/);
    if (m && method === 'POST') {
      const [, id, action] = m;
      const body = action === 'edit' || action === 'conflict' ? await readBody(req) : {};
      if (action === 'accept') return json(res, 200, { ok: true, entry: s.accept(id) });
      if (action === 'discard') return json(res, 200, { ok: true, ...s.discard(id) });
      if (action === 'conflict') {
        const choice = ['this', 'other', 'both'].includes(body.choice) ? body.choice : 'both';
        return json(res, 200, { ok: true, ...s.resolveConflict(id, choice) });
      }
      return json(res, 200, { ok: true, entry: s.edit(id, body) });
    }

    // 维护：标过期 + 蒸馏旧日记；撤销最近的自动写入
    if (p === '/api/maintain' && method === 'POST') return json(res, 200, { ok: true, ...s.maintain() });
    if (p === '/api/diag' && method === 'GET') return json(res, 200, { ok: true, diag: s.diag() });
    if (p === '/api/entry/supersede' && method === 'POST') {
      const { old: oldId, by, reason } = await readBody(req);
      return json(res, 200, { ok: true, ...s.supersede(oldId, { by, reason }) });
    }
    if (p === '/api/entry/unsupersede' && method === 'POST') {
      const { id } = await readBody(req);
      return json(res, 200, { ok: true, ...s.unsupersede(id) });
    }
    // 4C：项目实体 + 知识页（专题）
    if (p === '/api/projects' && method === 'GET') return json(res, 200, { ok: true, projects: s.projects() });
    if (p === '/api/project/rename' && method === 'POST') {
      const { id, name } = await readBody(req);
      return json(res, 200, { ok: true, project: s.renameProject(id, name) });
    }
    if (p === '/api/project/path' && method === 'POST') {
      const { id, dir, op } = await readBody(req);
      const project = op === 'remove' ? s.removeProjectPath(id, dir) : s.addProjectPath(id, dir);
      return json(res, 200, { ok: true, project });
    }
    if (p === '/api/project/merge' && method === 'POST') {
      const { from, into } = await readBody(req);
      return json(res, 200, { ok: true, ...s.mergeProjects(from, into) });
    }
    if (p === '/api/project/delete' && method === 'POST') {
      const { id } = await readBody(req);
      return json(res, 200, { ok: true, ...s.deleteProject(id) });
    }
    if (p === '/api/project/normalize' && method === 'POST') return json(res, 200, { ok: true, ...s.normalizeScopes() });
    if (p === '/api/pages' && method === 'GET') return json(res, 200, { ok: true, pages: s.pages() });
    if (p === '/api/page' && method === 'GET') {
      const slug = url.searchParams.get('slug') || '';
      return json(res, 200, { ok: true, page: s.page(slug) });
    }
    if (p === '/api/page/compose' && method === 'POST') {
      const { topic } = await readBody(req);
      const page = await s.composeTopic({ topic });
      if (!page) return json(res, 404, { ok: false, error: `没找到跟「${topic}」有关的条目` });
      return json(res, 200, { ok: true, page });
    }
    if (p === '/api/skills' && method === 'GET') return json(res, 200, { ok: true, skills: s.skills() });
    if (p === '/api/skill' && method === 'GET') {
      const slug = url.searchParams.get('slug') || '';
      const skill = s.skill(slug);
      if (!skill) return json(res, 404, { ok: false, error: '没有这个技能' });
      return json(res, 200, { ok: true, skill });
    }
    if (p === '/api/skill/delete' && method === 'POST') {
      const { slug } = await readBody(req);
      return json(res, 200, { ok: true, ...s.removeSkill(slug) });
    }
    if (p === '/api/scenes' && method === 'GET') return json(res, 200, { ok: true, scenes: s.scenes() });
    if (p === '/api/scene' && method === 'GET') {
      const id = url.searchParams.get('id') || '';
      const scene = s.scene(id);
      if (!scene) return json(res, 404, { ok: false, error: '没有这个场景' });
      return json(res, 200, { ok: true, scene });
    }
    if (p === '/api/scene/delete' && method === 'POST') {
      const { id } = await readBody(req);
      return json(res, 200, { ok: true, ...s.removeScene(id) });
    }
    if (p === '/api/page/delete' && method === 'POST') {
      const { slug } = await readBody(req);
      return json(res, 200, { ok: true, ...s.deletePage(slug) });
    }
    if (p === '/api/undo' && method === 'POST') {
      const body = await readBody(req);
      const n = Math.max(1, Number(body?.n) || 1);
      const undone = s.undo(n);
      return json(res, 200, { ok: true, undone });
    }
    if (p === '/api/auto-writes' && method === 'GET') return json(res, 200, { ok: true, entries: s.autoWrites(20) });

    // 垃圾桶：捞回 / 彻底删除（file 是相对 root 的路径，store 里会校验不许跑出记忆库）
    if (p === '/api/trash/restore' && method === 'POST') {
      const { file } = await readBody(req);
      return json(res, 200, { ok: true, entry: s.restore(file) });
    }
    if (p === '/api/trash/purge' && method === 'POST') {
      const { file } = await readBody(req);
      return json(res, 200, { ok: true, ...s.purgeTrash(file) });
    }

    if (p === '/api/stats' && method === 'GET') return json(res, 200, { ok: true, stats: s.stats() });
    return json(res, 404, { ok: false, error: `没有这个接口：${p}` });
  }

  /** 挂给 DSH 的统一入口：返回 true 表示这个请求归我处理 */
  async function handle(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (!url.pathname.startsWith(basePath)) return false;

    // 没有尾斜杠时补一个：页面里的相对路径（api/...）要能拼对
    if (url.pathname === basePath) {
      res.writeHead(302, { location: `${basePath}/` });
      res.end();
      return true;
    }

    try {
      if (url.pathname.startsWith(`${basePath}/api/`)) { await api(req, res, url); return true; }

      const rest = url.pathname.slice(basePath.length).replace(/^\/+/, '');
      const page = rest === '' || rest === 'panel/' ? 'index.html' : rest;
      if (!STATIC.has(path.basename(page))) { json(res, 404, { ok: false, error: '没有这个页面' }); return true; }

      // 没登录时一律给登录页，不泄露任何数据；
      // 但登录页自己要用的样式和图标必须放行，否则登录页会裸奔。
      if (!authed(req) && !PUBLIC.has(page)) { file(res, 'login.html'); return true; }
      file(res, page);
      return true;
    } catch (err) {
      json(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
      return true;
    }
  }

  return { handle, ensureAuth, authed, resetPassword, basePath, panelDir: PANEL_DIR };
}
