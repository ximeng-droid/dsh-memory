/* guard.js —— 安全闸：密钥拒写、隐私强制待确认（策划书 §12）
   两道闸的差别很重要：
   · 命中密钥 → 整条**拒绝**，连待确认箱都不进（不然等于把密码存进磁盘）
   · 命中隐私 → 仍然记，但强制 status=pending，必须你自己点头才生效 */

const SECRET = [
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{12,}/ },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'private-key', re: /BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY/ },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/ },
  { name: 'password-assign', re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i },
  { name: 'dsn', re: /\b(?:mysql|postgres|postgresql|mongodb|redis):\/\/[^\s:@]+:[^\s:@]+@/i },
];

const PRIVACY = [
  { name: 'identity', re: /\b\d{17}[\dXx]\b/ },                     // 身份证
  { name: 'bank-card', re: /\b(?:\d[ -]?){15,19}\b/ },              // 卡号
  { name: 'health', re: /病历|病史|诊断|处方|用药|手术|体检报告|抑郁症|癌/ },
  { name: 'money', re: /工资|薪资|年薪|月薪|银行卡|余额|存款|理财|贷款|信用卡/ },
  { name: 'address', re: /身份证号|家庭住址|住在.{0,6}(?:路|街|小区|号院)/ },
];

/**
 * @returns {{ ok: boolean, reject?: string, forcePending?: boolean, reasons: string[] }}
 */
export function check(text, options = {}) {
  const redact = options.redact !== false;
  const t = String(text || '');
  const reasons = [];

  if (redact) {
    for (const s of SECRET) {
      if (s.re.test(t)) {
        return { ok: false, reject: `含密钥（${s.name}），整条拒绝写入`, reasons: [s.name] };
      }
    }
  }

  let forcePending = false;
  for (const p of PRIVACY) {
    if (p.re.test(t)) {
      forcePending = true;
      reasons.push(p.name);
    }
  }
  return { ok: true, forcePending, reasons };
}

/** 给前端/日志用的脱敏（把疑似密钥打码，只用于展示） */
export function mask(text) {
  return String(text || '')
    .replace(/(sk-)[A-Za-z0-9_-]{8,}/g, '$1••••')
    .replace(/(AKIA)[0-9A-Z]{8,}/g, '$1••••')
    .replace(/(gh[pousr]_)[A-Za-z0-9]{8,}/g, '$1••••')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/g, '$1••••');
}

export { SECRET, PRIVACY };
