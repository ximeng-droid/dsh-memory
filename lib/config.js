/* 配置：<root>/config.json。缺字段一律用默认值补齐，读坏文件不炸。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  root: '',                                           // 空 = 用默认位置；填绝对路径就把记忆库挪过去
  writeMode: 'semi',                                  // manual | semi | auto
  capture: { minScore: 3, fromAssistant: true, skipSubagents: true, fastPath: true }, // 自动抽取门槛
  inject: { maxItems: 3, maxTokens: 400, includeMaps: true, splitSections: true, persona: true },
  skills: { inject: true, maxItems: 4 },
  dedupe: { merge: 0.82, related: 0.45, sameTypeMerge: 0.72 },   // sameTypeMerge：同类型条目放宽到 0.72 合并
  maintenance: { auto: true, staleDays: 90, dailyDays: 30, volatileDays: 30, journalMaxLines: 400, journalMaxBytes: 32768, autoArchive: true }, // 启动时标过期 + 蒸馏旧日记 + 日记归档
  projects: { autoCreate: true },                     // 抓取时按路径自动建项目实体
  pages: { inject: true, maxItems: 4, includeInPages: false, maxSources: 12 },   // 知识页：注入目录一行一条，最多 4 页；煮页最多 12 条来源
  vector: { enabled: true, model: 'Xenova/bge-small-zh-v1.5', dtype: 'q8', alpha: 0.6, cacheDir: '' }, // 向量检索（4D）：没装依赖会自动退回 BM25
  sessions: { enabled: true, retainDays: 90, scanOnStart: true, maxRawBytes: 8000000, coldAfterMin: 30, coldPerStart: 5, coldMinTurns: 3 }, // L0 原始流水（4E-1）
  dupes: { autoScan: true, autoMerge: true, autoMergeScore: 0.92, autoMergeSameTypeOnly: true, maxPerRun: 5, threshold: 0.88 },
  distill: {
    auto: true,
    retries: 3,
    maxInputChars: 24000,
    /* 单轮抽取（策划书 §25）；turnPolicy: 'B'=一律直接生效，'A'=只高置信的偏好/禁忌直接生效 */
    turnEnabled: true,
    turnPolicy: 'B',
    turnMaxEntries: 3,
    workerEveryMs: 60000,
    maxMergeTokens: 10000, gateCooldownMin: 10, dedupeSkip: 0.7, dedupeSkipVector: 0.82,
  }, // 会话蒸馏（4E-2）：auto=false 只手动跑
  llm: { provider: '', model: '' },                   // 空 = 跟随 DSH 当前默认模型
  panel: { requireAuth: true, user: 'owner', port: 0, // port=0 表示跟随 DSH；>0 时另起一个固定端口监听（如 8787）
    fixedPort: 0 },
};

/* 默认位置：DSH 数据目录下的 memory 子目录。用户另选位置后，这里只留一个「指针」（config.json 里的 root）。 */
export function defaultRoot() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'memory');
}

/* 插件启动时用它决定仓库在哪：显式配置 > 默认位置里的指针 > 默认位置。 */
export function resolveRoot(explicit) {
  const home = defaultRoot();
  const picked = String(explicit || '').trim();
  if (picked) return path.resolve(picked);
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    const saved = String(pointer.root || '').trim();
    if (saved && fs.existsSync(saved)) return path.resolve(saved);
  } catch { /* 没有指针就用默认 */ }
  return home;
}

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = merge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function configPath(root) { return path.join(root, 'config.json'); }

/* 磁盘上真实写了哪些键（未与默认值合并）。用来判断某个键是不是用户已经选过了。 */
export function readRawConfig(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(root), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function loadConfig(root) {
  try {
    const raw = fs.readFileSync(configPath(root), 'utf8');
    return merge(DEFAULT_CONFIG, JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(root, patch) {
  const next = merge(loadConfig(root), patch || {});
  fs.mkdirSync(root, { recursive: true });
  const tmp = `${configPath(root)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, configPath(root));
  return next;
}
