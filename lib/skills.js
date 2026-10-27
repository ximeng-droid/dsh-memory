/**
 * 技能层：把「可复用的操作方法」写成 skills/<slug>.md。
 *
 * 与 DSH 自己的 skill 工具无关 —— 那个读磁盘固定目录、由模型自己调。
 * 这里是「可检索的操作手册」：只把标题与关键词放进每轮注入，全文靠检索取。
 */
import fs from 'node:fs';
import path from 'node:path';
import { clip, now, today } from './util.js';
import { slugOf } from './scenes.js';

export const SKILLS_DIR = 'skills';
export const SKILL_INDEX = 'index.json';
export const SKILL_SECTIONS = [
  ['when', '什么时候用'],
  ['how', '怎么做'],
  ['pitfalls', '坑'],
  ['verify', '验证'],
];
export const MAX_INJECT = 4;

export function skillsDir(store) {
  const dir = store.dir(SKILLS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function skillSlug(title) {
  return slugOf(title, 28);
}

export function skillPath(store, slug) {
  return path.join(skillsDir(store), `${slug}.md`);
}

const arr = (v) => (Array.isArray(v) ? v : []).map((x) => String(x || '').trim()).filter(Boolean);

export function renderSkill(skill) {
  const head = [
    'type: skill',
    `slug: ${skill.slug}`,
    `title: ${skill.title}`,
    `scope: [${arr(skill.scope).join(', ')}]`,
    `keywords: [${arr(skill.keywords).join(', ')}]`,
    `status: ${skill.status || 'active'}`,
    `source: ${skill.source || 'distill'}`,
    `uses: ${Number(skill.uses) || 0}`,
    `created: ${skill.created || now()}`,
    `updated: ${skill.updated || now()}`,
  ].join('\n');
  const body = SKILL_SECTIONS.map(([key, label]) => {
    const val = skill[key];
    if (Array.isArray(val)) {
      const lines = arr(val).map((s) => `- ${s}`).join('\n');
      return `## ${label}\n\n${lines || '（没有）'}\n`;
    }
    return `## ${label}\n\n${String(val || '').trim() || '（没有）'}\n`;
  }).join('\n');
  return `---\n${head}\n---\n\n# ${skill.title}\n\n${body}`;
}

export function readSkill(store, slug) {
  const file = skillPath(store, slug);
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
  const list = (label) => {
    const re = new RegExp(`## ${label}\\r?\\n\\r?\\n([\\s\\S]*?)(?:\\r?\\n## |$)`);
    const hit = re.exec(body);
    const raw = hit ? hit[1].trim() : '';
    if (!raw || raw === '（没有）') return [];
    return raw.split(/\r?\n/).map((s) => s.replace(/^-\s*/, '').trim()).filter(Boolean);
  };
  const text1 = (label) => {
    const re = new RegExp(`## ${label}\\r?\\n\\r?\\n([\\s\\S]*?)(?:\\r?\\n## |$)`);
    const hit = re.exec(body);
    const raw = hit ? hit[1].trim() : '';
    return raw === '（没有）' ? '' : raw;
  };
  const unlist = (v) => String(v || '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    slug: head.slug || slug,
    title: head.title || slug,
    scope: unlist(head.scope).length ? unlist(head.scope) : ['global'],
    keywords: unlist(head.keywords),
    status: head.status || 'active',
    source: head.source || '',
    uses: Number(head.uses) || 0,
    created: head.created || '',
    updated: head.updated || '',
    when: text1('什么时候用'),
    how: list('怎么做'),
    pitfalls: list('坑'),
    verify: text1('验证'),
    file: `${SKILLS_DIR}/${head.slug || slug}.md`,
  };
}

export function listSkills(store) {
  const dir = skillsDir(store);
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const s = readSkill(store, name.slice(0, -3));
    if (s) out.push(s);
  }
  out.sort((a, b) => String(b.updated || b.created).localeCompare(String(a.updated || a.created)));
  return out;
}

export function writeSkill(store, skill, meta = {}) {
  const slug = skillSlug(skill.slug || skill.title);
  const prev = readSkill(store, slug);
  const full = {
    slug,
    title: clip(skill.title, 48) || '未命名技能',
    scope: arr(skill.scope).length ? arr(skill.scope) : arr(meta.scope).length ? arr(meta.scope) : ['global'],
    keywords: arr(skill.keywords).length ? arr(skill.keywords) : arr(meta.keywords),
    status: skill.status || prev?.status || 'active',
    source: skill.source || meta.source || prev?.source || 'distill',
    uses: Number(skill.uses ?? prev?.uses) || 0,
    created: prev?.created || skill.created || now(),
    updated: now(),
    when: clip(skill.when, 400),
    how: arr(skill.how).map((s) => clip(s, 240)).slice(0, 12),
    pitfalls: arr(skill.pitfalls).map((s) => clip(s, 240)).slice(0, 8),
    verify: clip(skill.verify, 300),
  };
  fs.writeFileSync(skillPath(store, slug), renderSkill(full), 'utf8');
  writeSkillIndex(store);
  return { slug, file: `${SKILLS_DIR}/${slug}.md`, title: full.title, status: full.status };
}

export function writeSkillIndex(store) {
  const skills = listSkills(store).map((s) => ({
    slug: s.slug, title: s.title, scope: s.scope, keywords: s.keywords,
    status: s.status, uses: s.uses, updated: s.updated, when: s.when, file: s.file,
  }));
  fs.writeFileSync(path.join(skillsDir(store), SKILL_INDEX), JSON.stringify({ version: 1, built_at: now(), skills }, null, 2), 'utf8');
  return { version: 1, built_at: now(), skills };
}

export function readSkillIndex(store) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(skillsDir(store), SKILL_INDEX), 'utf8'));
    if (data && Array.isArray(data.skills)) return data;
  } catch { /* 坏文件或不存在 */ }
  return writeSkillIndex(store);
}

export function deleteSkill(store, slug) {
  const file = skillPath(store, slug);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  writeSkillIndex(store);
  return true;
}

/** 作用域匹配：全局 + 当前项目；同名 slug 时项目覆盖全局 */
export function skillsForScope(store, { project = '', global = true } = {}) {
  const all = listSkills(store).filter((s) => s.status === 'active');
  const keep = all.filter((s) => {
    const sc = Array.isArray(s.scope) ? s.scope : ['global'];
    if (global && sc.includes('global')) return true;
    if (!project) return false;
    const want = String(project).startsWith('project:') ? String(project) : `project:${project}`;
    return sc.includes(want) || sc.includes(project);
  });
  const bySlug = new Map();
  for (const s of keep) {
    const prev = bySlug.get(s.slug);
    if (!prev || (prev.scope.includes('global') && !s.scope.includes('global'))) bySlug.set(s.slug, s);
  }
  return [...bySlug.values()].sort((a, b) => (b.uses || 0) - (a.uses || 0));
}

/** 注入用的一行式：只发标题与关键词 */
export function skillLine(s) {
  const kw = (s.keywords || []).slice(0, 3).join('、');
  return `- [技能] ${s.title}${kw ? ` —— 关键词：${kw}` : ''}`;
}

export function skillLines(skills, { maxItems = MAX_INJECT } = {}) {
  return (skills || []).slice(0, maxItems).map(skillLine);
}
