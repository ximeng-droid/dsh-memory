/* projects.js —— 项目实体（策划书 §23.8）
   记忆挂到「项目」这个实体上，而不是一串路径。
   向后兼容：老条目里的 project:<路径> 照样认，读时等价映射成实体，不改历史文件。 */
import fs from 'node:fs';
import path from 'node:path';

import { now, safeName } from './util.js';

export const PROJECTS_FILE = 'projects.json';
export const PROJECTS_VERSION = 1;

export function projectsPath(store) {
  return path.join(store.root, PROJECTS_FILE);
}

export function emptyProjects() {
  return { version: PROJECTS_VERSION, projects: [] };
}

export function readProjects(store) {
  try {
    const raw = JSON.parse(fs.readFileSync(projectsPath(store), 'utf8'));
    if (!raw || !Array.isArray(raw.projects)) return emptyProjects();
    return { version: PROJECTS_VERSION, projects: raw.projects.filter((p) => p && p.id) };
  } catch {
    return emptyProjects();
  }
}

export function writeProjects(store, data) {
  const out = { version: PROJECTS_VERSION, projects: (data.projects || []).map((p) => ({
    id: String(p.id),
    name: String(p.name || p.id),
    paths: Array.isArray(p.paths) ? p.paths.map(String).filter(Boolean) : [],
    created: p.created || now(),
    note: p.note || '',
  })) };
  store.atomicWrite(projectsPath(store), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

const trim = (p) => String(p || '').trim().replace(/[\\/]+$/, '');

/** 路径是不是落在实体声明的某个目录里（含子目录） */
export function pathInProject(project, cwd) {
  const want = trim(cwd).toLowerCase();
  if (!want) return false;
  return (project?.paths || []).some((raw) => {
    const p = trim(raw).toLowerCase();
    if (!p) return false;
    return want === p || want.startsWith(`${p}\\`) || want.startsWith(`${p}/`);
  });
}

export function findByPath(data, cwd) {
  return (data.projects || []).find((p) => pathInProject(p, cwd)) || null;
}

export function findById(data, id) {
  const key = String(id || '');
  return (data.projects || []).find((p) => String(p.id) === key) || null;
}

/** 新实体的 id：p-<末段小写安全名>，撞名加序号 */
export function nextProjectId(data, nameOrPath) {
  const base = String(nameOrPath || '').split(/[\\/]/).filter(Boolean).pop() || 'project';
  const stem = safeName(base).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  let id = `p-${stem}`;
  let n = 2;
  while (findById(data, id)) { id = `p-${stem}-${n}`; n += 1; }
  return id;
}

/** 确保 cwd 对应的实体存在（autoCreate=false 时只找不建） */
export function ensureProject(store, cwd, { autoCreate = true, name = '' } = {}) {
  const target = trim(cwd);
  if (!target) return null;
  const data = readProjects(store);
  const hit = findByPath(data, target);
  if (hit) return hit;
  if (!autoCreate) return null;
  const id = nextProjectId(data, name || target);
  const fresh = {
    id,
    name: String(name || target.split(/[\\/]/).filter(Boolean).pop() || id),
    paths: [target],
    created: now(),
    note: '',
  };
  data.projects.push(fresh);
  writeProjects(store, data);
  return fresh;
}

/**
 * 范围里如果能对上实体的路径，就换成实体 id（只在写新条目时用；老文件一律不动）。
 * 返回新数组，原数组不变。
 */
export function toEntityScopes(store, scopes, { autoCreate = true } = {}) {
  const list = Array.isArray(scopes) ? scopes : scopes ? [scopes] : [];
  const data = readProjects(store);
  return list.map((raw) => {
    const s = String(raw || '');
    if (!s.startsWith('project:')) return s;
    const val = s.slice('project:'.length);
    if (findById(data, val)) return s;                    // 已经是实体 id
    if (!/[\\/]/.test(val)) return s;                     // 不像路径，原样保留
    const entity = ensureProject(store, val, { autoCreate });
    return entity ? `project:${entity.id}` : s;
  });
}

/** 把一条范围渲染成给人看的标签 */
export function describeScope(store, raw, projectsData) {
  const s = String(raw || '');
  if (s === 'global') return '全局';
  if (!s.startsWith('project:')) return s || '全局';
  const val = s.slice('project:'.length);
  const data = projectsData || readProjects(store);
  const entity = findById(data, val);
  if (entity) return `项目：${entity.name}`;
  return `项目：${val.split(/[\\/]/).filter(Boolean).pop() || val}`;
}
