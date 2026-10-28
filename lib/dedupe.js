/* dedupe.js —— 去重与冲突（策划书 §9）
   相似度用字符 3-gram 余弦（零依赖）。三档动作：merge / related / conflict / new。 */

import { similarity, norm, clip, tokenize } from './util.js';

/** 从文本里抠出「会互相打架的具体值」：版本号、端口、盘符路径、数字 */
export function values(text) {
  const t = String(text || '');
  const out = new Set();
  for (const m of t.matchAll(/\bv?\d+(?:\.\d+){1,3}(?:-[a-z0-9.]+)?\b/gi)) out.add(m[0].toLowerCase().replace(/^v/, ''));
  for (const m of t.matchAll(/\bv\d{1,3}\b/gi)) out.add(m[0].toLowerCase().replace(/^v/, ''));
  for (const m of t.matchAll(/\b\d{2,5}\b/g)) out.add(m[0]);
  for (const m of t.matchAll(/[A-Za-z]:\\[^\s，。；)）]+/g)) out.add(m[0].toLowerCase());
  return out;
}

const NEG = /别再|不要用|别用|不能用|禁止|不允许|不是|避免|改回|改成/;

/** 两条记忆是不是在说同一件事但结论相反 */
export function contradicts(a, b) {
  const A = values(a);
  const B = values(b);
  const aNeg = NEG.test(a);
  const bNeg = NEG.test(b);
  // 数值完全一致 → 不冲突（哪怕一句带否定词，也只是同一结论的两种说法）
  const differs = [...A].some((x) => !B.has(x)) || [...B].some((x) => !A.has(x));
  if (!differs) return false;
  // 一方是否定句式（"别再 / 改回 / 不是"）→ 判定门槛放宽
  const need = (aNeg || bNeg) ? 1 : 2;
  // 只有一边带具体数值 → 不是「数值矛盾」，只是提到了不同细节
  if (!A.size || !B.size) return false;
  // 看是否在讲同一件事：共同词达到门槛，且数值有出入
  return sharedWords(a, b) >= need;
}

function sharedWords(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared;
}

/**
 * 能不能判成「更正链」（新值顶旧值，自动）而不是「冲突」（要人裁决）。
 * 分界：同类型 + 两边都带具体数值 + 谁都没用否定/改回这种相反句式 + 在讲同一件事（共同词≥2）。
 * 任何一条不满足就交回给人。
 */
export function canSupersede(candidate, old) {
  if (!old) return { ok: false };
  const t1 = String(candidate?.type || '');
  const t2 = String(old.type || '');
  if (!t1 || t1 !== t2) return { ok: false };
  const a = `${candidate.title || ''} ${candidate.body || ''}`;
  const b = `${old.title || ''} ${old.body || ''}`;
  if (NEG.test(a) || NEG.test(b)) return { ok: false };
  const A = values(a);
  const B = values(b);
  if (!A.size || !B.size) return { ok: false };
  const shared = sharedWords(a, b);
  if (shared < 2) return { ok: false };
  // 旧条里有、新条里没有的值 = 被更新的那些
  const gone = [...B].filter((x) => !A.has(x)).slice(0, 3);
  const fresh = [...A].filter((x) => !B.has(x)).slice(0, 3);
  if (!gone.length && !fresh.length) return { ok: false };
  const reason = `数值更新（${gone.join('、') || '旧值'} → ${fresh.join('、') || '新值'}）`;
  return { ok: true, reason, gone, fresh, shared };
}

/**
 * @param {{title:string, body:string, type?:string}} candidate
 * @param {Array} existing 已有条目
 * @param {{merge?:number, related?:number}} opts
 * @returns {{action:'merge'|'related'|'conflict'|'new', match?:object, score:number, note:string}}
 */
/** 两条记录共用的词素个数：判断「换了说法但其实是同一条」。 */
function sharedKeywords(a, b) {
  const one = new Set(tokenize(`${a.title || ''} ${a.body || ''}`).filter((t) => t.length >= 2));
  if (!one.size) return 0;
  let n = 0;
  for (const t of new Set(tokenize(`${b.title || ''} ${b.body || ''}`).filter((x) => x.length >= 2))) {
    if (one.has(t)) n += 1;
  }
  return n;
}

export function compare(candidate, existing = [], opts = {}) {
  const mergeAt = opts.merge ?? 0.82;
  const sameTypeAt = opts.sameTypeMerge ?? 0.72;   // 同类型条目文字差异大也合并（读起来不同、规矩其实是同一条）
  const relatedAt = opts.related ?? 0.45;
  const probe = `${candidate.title || ''} ${candidate.body || ''}`;
  let best = null;
  let bestScore = 0;
  let bestSame = false;
  let bestShared = 0;

  for (const e of existing) {
    const s = similarity(probe, `${e.title || ''} ${e.body || ''}`);
    const kw = sharedKeywords(candidate, e);
    if (s > bestScore || (kw >= 5 && kw > bestShared)) {
      if (s > bestScore) bestScore = s;
      best = e;
      bestSame = Boolean(candidate.type) && candidate.type === e.type;
      bestShared = Math.max(bestShared, kw);
    }
  }

  // 同一类型（都是偏好/禁令/事实…）时放宽两档：
  //   ① 字面相似度 0.72 就合并（原来一律 0.82）；
  //   ② 换了个说法但关键词重合 5 个以上、且确实是同一类型的，也合并——
  //      例：「技术讲解先大白话再补专有名词」vs「技术内容先讲大白话，专有名词和英文要解释」，
  //      余弦只有 0.37，但共用 13 个词素，是同一条规矩。不合并就会每轮注入重复占位。
  const sameTypeMerge = bestSame && (bestScore >= sameTypeAt || (bestShared >= 5 && bestScore >= 0.3));
  if (best && (bestScore >= mergeAt || sameTypeMerge)) {
    return { action: 'merge', match: best, score: bestScore, note: `与 ${best.id} 几乎相同（${bestScore.toFixed(2)}），合并到旧条` };
  }

  // 更正链不看整体相似度：短条目（"面板端口：9000"）跟旧条的余弦天然很低，
  // 但它明确是「同一个槽位、值变了」。所以单独按「共同词 + 数值变化」找一遍。
  let supBest = null;
  for (const e of existing) {
    const sup = canSupersede(candidate, e);
    if (!sup.ok) continue;
    const weight = sup.shared * 10 + (sup.gone.length ? 5 : 0);
    if (!supBest || weight > supBest.weight) supBest = { e, sup, weight };
  }
  if (supBest && (supBest.sup.shared >= 3 || bestScore >= 0.35)) {
    return {
      action: 'supersede',
      match: supBest.e,
      score: bestScore,
      reason: supBest.sup.reason,
      note: `顶掉 ${supBest.e.id}：${supBest.sup.reason}`,
    };
  }

  if (best && bestScore >= relatedAt) {
    const conflict = contradicts(probe, `${best.title || ''} ${best.body || ''}`);
    if (conflict) {
      return { action: 'conflict', match: best, score: bestScore, note: `与 ${best.id} 结论相反（${bestScore.toFixed(2)}）` };
    }
    return { action: 'related', match: best, score: bestScore, note: `与 ${best.id} 相关（${bestScore.toFixed(2)}）` };
  }

  return { action: 'new', score: bestScore, note: '新条目' };
}

/** 合并：保留旧 id，正文取更新的一条，hits+1 */
export function merged(old, candidate, nowStr) {
  const body = clip(
    norm(old.body) === norm(candidate.body)
      ? old.body
      : `${candidate.body}\n\n（旧版：${clip(old.body || '', 120)}）`,
    300,
  );
  return {
    ...old,
    title: candidate.title || old.title,
    body,
    updated: nowStr,
    hits: Number(old.hits || 0) + 1,
  };
}
