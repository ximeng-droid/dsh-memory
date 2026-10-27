/* rules.js —— 规则引擎（B2 档）
   输入一段对话（本轮 user + assistant 的纯文本），输出「候选记忆」。
   打分口径来自策划书 §8：显式指令 +3、硬事实 +2、决策 +2、踩坑 +2、否定 +2、项目事实 +1；
   ≥3 才是候选，≥5 才允许 auto 直接落盘。

   这一层只负责「看起来值得记」，不判断真假、不写盘。 */

import { norm, oneline, clip } from './util.js';

/* ---------- 触发词表 ---------- */

const R = {
  explicit: {
    weight: 3,
    re: /记住|记一下|记下来|以后都|以后只|今后都|统一用|统一改成|别再|不要再|下次|我的习惯|我习惯|我偏好|我倾向于|一律/g,
    types: ['preference', 'forbidden'],
  },
  negate: {
    weight: 2,
    re: /不是[^。；;]{1,20}(?:而是|是)|别再|不要用|别用|不能用|禁止|不允许|避免/g,
    types: ['forbidden'],
  },
  decision: {
    weight: 2,
    re: /就这样|就这么定|定了|按这个来|先不动|先这样|等上游|暂缓|结论是|最终决定/g,
    types: ['decision'],
  },
  experience: {
    weight: 2,
    re: /报错|失败|崩了|卡住|原因是|解决方法是?|教训|踩坑|根因|修好了|绕过去/g,
    types: ['experience'],
  },
  fact: {
    weight: 2,
    re: /[A-Za-z]:\\[^\s，。；]+|\d+\.\d+\.\d+(?:-[a-z0-9.]+)?|:\d{4,5}\b|(?:端口|监听|跑在|占用)\s*[:：]?\s*\d{2,5}\b|https?:\/\/[^\s，。；]+|\b(?:git|pnpm|npm|node|pwsh|python|docker)\b/g,
    types: ['fact'],
  },
  project: {
    weight: 1,
    re: /本项目|这个项目|这个仓库|工作区|当前目录/g,
    types: ['project'],
  },
};

/* ---------- 直接丢弃的噪音 ---------- */

const NOISE = [
  /^\s*(你好|您好|嗨|hi|hello|谢谢|多谢|好的|好|ok|嗯|收到|明白|了解|早安|晚安|在吗)[\s!！。.,，~]*$/i,
  /^Time sampled while preparing turn[^\n]*/i,
  /^Elapsed since the preceding model-visible message:/i,
  /^Current DeepSeek Harness (Web GUI URL|implementation checkout)/i,
  /^Current working directory:/i,
];

/* ---------- 类型裁决 ----------
   一句话里可能同时命中多条规则，按「越具体越优先」取一个类型。 */

const TYPE_PRIORITY = ['forbidden', 'preference', 'decision', 'experience', 'fact', 'project'];

const TYPE_LABEL = {
  preference: '偏好',
  forbidden: '禁令',
  decision: '决定',
  experience: '经验',
  fact: '事实',
  project: '项目',
  profile: '画像',
  task: '任务',
  map: '图',
};

const GLOBAL_HINT = /以后都|以后只|今后都|统一|一律|永远|总是|一直|默认/;

/* ---------- 句子切分 ---------- */

function splitSentences(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/(?<=[。！？!?；;])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 去掉 markdown 代码块 —— 纯代码不记 */
export function stripCode(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]{1,80}`/g, ' ')
    .trim();
}

export function isNoise(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (t.length < 8) return true;
  if (NOISE.some((re) => re.test(t))) return true;
  // 纯符号 / 纯标点
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  return false;
}

/* ---------- 打分 ---------- */

export function scoreSentence(sentence) {
  const hits = [];
  let score = 0;
  const types = new Set();
  for (const [name, rule] of Object.entries(R)) {
    rule.re.lastIndex = 0;
    const m = sentence.match(rule.re);
    if (m && m.length) {
      // 同一规则一次只加一次权重，避免一句话里出现 5 个路径就冲到 10 分
      score += rule.weight;
      hits.push(`${name}×${m.length}`);
      rule.types.forEach((t) => types.add(t));
    }
  }
  return { score, hits, types: [...types] };
}

function pickType(types) {
  for (const t of TYPE_PRIORITY) if (types.includes(t)) return t;
  return 'fact';
}

function makeTitle(sentence, type) {
  let t = oneline(sentence, 0);
  // 去掉句末标点
  t = t.replace(/[。！？!?；;，,]\s*$/, '');
  // 「以后都用 DSH 自带的 pnpm」这类，把引导词去掉读起来更像记忆标题
  if (type === 'preference' || type === 'forbidden') {
    t = t.replace(/^(记住|记一下|记下来|以后都|以后只|今后都|统一用|统一改成|别再|不要再|下次|给我)/, '').trim() || t;
  }
  return clip(t, 40);
}

function scopeOf(sentence, cwd) {
  if (GLOBAL_HINT.test(sentence)) return 'global';
  if (cwd && /本项目|这个项目|这个仓库|工作区|当前目录/.test(sentence)) return `project:${cwd}`;
  // 提到了具体盘符路径，且不是当前工作区 → 仍按当前项目算（保守：宁可少注入）
  return cwd ? `project:${cwd}` : 'global';
}

/**
 * 从一轮对话里抽候选。
 * @param {{ user?: string, assistant?: string, cwd?: string, source?: string, minScore?: number }} input
 * @returns {{ candidates: Array, dropped: Array, skipped: string }}
 */
export function extract(input = {}) {
  const { user = '', assistant = '', cwd = '', source = '', minScore = 3 } = input;
  const text = stripCode(`${user}\n${assistant}`.trim());
  if (!text) return { candidates: [], dropped: [], skipped: 'empty' };

  const sentences = splitSentences(text);
  const candidates = [];
  const dropped = [];
  const seen = new Set();

  for (const s of sentences) {
    if (isNoise(s)) continue;
    const { score, hits, types } = scoreSentence(s);
    if (score < minScore) {
      if (score > 0) dropped.push({ sentence: clip(s, 60), score, why: 'below-threshold' });
      continue;
    }
    const type = pickType(types);
    const title = makeTitle(s, type);
    if (!title || seen.has(norm(title))) continue;
    seen.add(norm(title));
    candidates.push({
      type,
      title,
      body: clip(oneline(s, 0), 300),
      scope: [scopeOf(s, cwd)],
      score,
      rules: hits,
      source,
      source_trust: 'session',
    });
  }

  // 一句话里抽出的多条容易互相重复：标题互相包含的只留分高的
  const final = [];
  for (const c of candidates.sort((a, b) => b.score - a.score)) {
    const dup = final.find((f) => {
      const a = norm(f.title);
      const b = norm(c.title);
      return a === b || a.includes(b) || b.includes(a);
    });
    if (dup) continue;
    final.push(c);
  }
  return { candidates: final, dropped, skipped: '' };
}

export { TYPE_LABEL, TYPE_PRIORITY };

/* ------------------------------------------------------------------
   闸门：这一轮值不值得送去模型判「有没有该记的」
   纯本地正则，0 成本；命中只代表"值得问模型"，不代表一定入库。
   设计见 策划书 §25.3。
   ------------------------------------------------------------------ */
const ASK_IMPERATIVE = /(记住|记一下|记到|以后都|以后用|以后别|以后不要|一律|统一用|统一采用|别用|不要用|不许|禁止|必须|加上|加进|写进|写进文档|不做|不要做|不用做|不用加|改成|改一下|去掉|删掉|按这个来|照这个|标准|约定|原则|规范|规矩)/

/** 用户这句话是不是在定规矩（快速通道专用：命中就直接按规则入库，不调模型） */
export function userGivesRule(text) {
  return ASK_IMPERATIVE.test(String(text || ''))
}

/** 助手回复有没有「结构」（标题/编号/列表/分点词）——判断它是不是一份值得留的总结 */
function hasStructure(text) {
  const t = String(text || '')
  const marks = (t.match(/^(#{1,4}\s|\d+[.、)]\s|[-*]\s)/gm) || []).length
  const words = (t.match(/(步骤|流程|结论|总结|清单|做法|注意事项|关键点)/g) || []).length
  return marks >= 3 || words >= 2
}

/**
 * 这一轮值不值得让模型看一眼（§26.4）。
 * 只回答「要不要送去提炼」，不回答「要不要落档」——落档每轮都做，不看这个。
 */
export function worthAsking({ user = '', assistant = '', attachments = 0, tools = 0 } = {}) {
  const u = String(user || '')
  const a = String(assistant || '')
  const files = Number(attachments) || 0
  const reasons = []

  // 高：用户在定规矩；或者这一轮带了图/文件（内容可能在图里，文字层看不全）
  if (ASK_IMPERATIVE.test(u)) reasons.push({ level: 'high', why: '用户说了规范类的话' })
  if (files > 0) reasons.push({ level: 'high', why: '带了 ' + files + ' 个附件' })
  // 中：助手给了一份有结构的总结（够长 + 有标题/列表/分点），不是纯闲聊
  if (a.length >= 300 && hasStructure(a)) reasons.push({ level: 'mid', why: '助手给了一份有结构的总结' })
  // 低：只记录，不触发
  if (Number(tools) > 0) reasons.push({ level: 'low', why: '调了 ' + tools + ' 次工具' })

  const rank = { high: 3, mid: 2, low: 1 }
  const level = reasons.reduce((acc, x) => ((rank[x.level] || 0) > (rank[acc] || 0) ? x.level : acc), '')
  return { hit: level === 'high' || level === 'mid', level, reasons }
}
