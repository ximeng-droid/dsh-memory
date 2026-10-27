/* vector.js —— 可插拔向量检索（策划书 §23.9 · B 路线：本机 ONNX）
   设计原则：
   1) 有依赖就用，没依赖就完全退回 BM25 —— 任何一步失败都只是「少一档能力」，不影响记忆本身。
   2) 模型只加载一次，向量按条目内容指纹增量补齐；内容没变就不重算。
   3) 向量单独存在 <root>/.vectors.json，删掉它能自动重建（和 index.json 一个待遇）。

   实测（本机，Xenova/bge-small-zh-v1.5 q8）：22.9 MB、512 维、首次加载 ~4 s、之后每条 ~6 ms。
*/

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

export const VECTOR_FILE = '.vectors.json';
export const VECTOR_VERSION = 1;
export const DEFAULT_MODEL = 'Xenova/bge-small-zh-v1.5';

/** 内容指纹：标题 + 正文，正文取前 800 字（长尾对语义影响小，省时间） */
export function fingerprint(entry) {
  const raw = `${entry.title || ''}\u0000${(entry.body || '').slice(0, 800)}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

export function vectorsPath(store) {
  return store.dir(VECTOR_FILE);
}

export function emptyVectors(model = DEFAULT_MODEL) {
  return { version: VECTOR_VERSION, model, dim: 0, updated: '', items: {} };
}

export function readVectors(store) {
  try {
    const raw = fs.readFileSync(vectorsPath(store), 'utf8');
    const data = JSON.parse(raw);
    if (!data || data.version !== VECTOR_VERSION || !data.items) return emptyVectors();
    return data;
  } catch {
    return emptyVectors();
  }
}

export function writeVectors(store, data) {
  const file = vectorsPath(store);
  const body = JSON.stringify({ ...data, updated: new Date().toISOString() });
  const tmp = path.join(path.dirname(file), `.vectors-${process.pid}.tmp`);
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
  return data;
}

/**
 * 懒加载嵌入器。返回 null 表示「这台机器上没有可用的向量能力」。
 * opts: { model, dtype, cacheDir }
 */
export function createEmbedder(opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const dtype = opts.dtype || 'q8';
  let pipePromise = null;
  let failed = null;
  let dim = 0;

  /**
   * 本地模型目录：<cacheDir>/<模型名去掉作者前缀>
   * 有 config.json 就直接读本地，永不联网；没有才回退到按 model id 远程取。
   */
  function localDir() {
    if (!opts.cacheDir) return '';
    const slug = model.split('/').pop();
    const dir = path.join(opts.cacheDir, slug);
    try {
      return fs.existsSync(path.join(dir, 'config.json')) ? dir : '';
    } catch {
      return '';
    }
  }

  async function load() {
    if (pipePromise) return pipePromise;
    pipePromise = (async () => {
      // 先确认依赖装没装：没装就别去联网，直接失败（避免每次搜索卡十秒超时）
      try {
        createRequire(import.meta.url).resolve('@huggingface/transformers');
      } catch {
        throw new Error('没装 @huggingface/transformers（向量检索不可用）');
      }
      if (opts.cacheDir) process.env.HF_HOME ||= opts.cacheDir;
      const mod = await import('@huggingface/transformers');
      const factory = mod.pipeline || mod.default?.pipeline;
      if (typeof factory !== 'function') throw new Error('transformers 里没有 pipeline');
      const dir = localDir();
      if (dir) {
        // 本地优先：模型文件已就位，彻底断网也能跑
        const env = mod.env || mod.default?.env;
        if (env) {
          env.allowRemoteModels = false;
          env.allowLocalModels = true;
        }
        return factory('feature-extraction', dir, { dtype, local_files_only: true });
      }
      return factory('feature-extraction', model, { dtype });
    })();
    return pipePromise;
  }

  return {
    model,
    get dim() { return dim; },
    get error() { return failed; },
    /** 批量取向量：返回 [[float...], ...]；失败抛错，由调用方吞掉 */
    async embed(texts) {
      const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ''));
      if (!list.length) return [];
      const pipe = await load();
      const out = await pipe(list, { pooling: 'cls', normalize: true });
      const rows = out.tolist();
      if (rows.length && Array.isArray(rows[0])) dim = rows[0].length;
      return rows;
    },
    markFailed(err) { failed = err; pipePromise = null; },
  };
}

/** 余弦（两边都已归一化时就是点积，这里仍然算全式，防止外部传进来的没归一化） */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * 增量补齐向量：只算新增/内容变了的条目；顺手清掉已删除条目的向量。
 * 返回 { data, embedded, total }
 */
export async function ensureVectors(store, entries, embedder, { limit = 200 } = {}) {
  const data = readVectors(store);
  if (embedder?.model && data.model !== embedder.model) {
    // 换模型 ⇒ 旧向量作废（维度都对不上）
    data.model = embedder.model;
    data.items = {};
  }
  const alive = new Set(entries.map((e) => String(e.id)));
  let pruned = false;
  for (const id of Object.keys(data.items)) {
    if (!alive.has(id)) { delete data.items[id]; pruned = true; }
  }

  const todo = [];
  for (const e of entries) {
    const id = String(e.id);
    const fp = fingerprint(e);
    const hit = data.items[id];
    if (hit && hit.fp === fp && Array.isArray(hit.v) && hit.v.length) continue;
    todo.push({ id, fp, text: `${e.title || ''}\n${(e.body || '').slice(0, 800)}` });
  }
  const batch = todo.slice(0, limit);
  if (!batch.length) {
    if (pruned) writeVectors(store, data);
    return { data, embedded: 0, total: Object.keys(data.items).length };
  }

  const rows = await embedder.embed(batch.map((b) => b.text));
  batch.forEach((b, i) => {
    const v = rows[i];
    if (Array.isArray(v) && v.length) {
      data.items[b.id] = { fp: b.fp, v: v.map((x) => Math.round(x * 1e4) / 1e4) };
      data.dim = v.length;
    }
  });
  writeVectors(store, data);
  return { data, embedded: batch.length, total: Object.keys(data.items).length };
}

/** 给面板/诊断看的一句话状态 */
export function describeVectors(data, { enabled = true } = {}) {
  if (!enabled) return '向量检索：关（只用 BM25）';
  if (!data || !data.items || !Object.keys(data.items).length) return '向量检索：还没建（只有 BM25 在起作用）';
  return `向量检索：${Object.keys(data.items).length} 条已建（${data.model}，${data.dim} 维）`;
}
