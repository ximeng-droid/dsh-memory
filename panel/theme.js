/* theme.js —— 主题轴（明暗 × 版式）+ 主题色 + 玻璃透明度 + 背景图
   世界映射：纸感浅色=a 纸感深色=b 玻璃深色=d 玻璃浅色=g
   这个文件只服务原型，方便点着玩；真实现时这些值从 config.json 读。 */

const STATE = {
  mode: 'light',      // light | dark
  style: 'solid',     // solid | glass
  accent: '',         // '' = 用世界的默认强调色
  glass: 42,          // 透明度 20–70
  fs: 'm',            // s | m | l（字号）
  image: null,        // object URL
};

const WORLDS = {
  'light|solid': 'a',
  'dark|solid': 'b',
  'dark|glass': 'd',
  'light|glass': 'g',
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* 折射滤镜：玻璃面用 backdrop-filter: url(#frost-refract) 把背景轻轻掰弯，
   玻璃才不像「一层糊掉的纸」。噪声先糊一遍再位移 —— 起伏是大尺度的，不是雪花点。 */
const FROST_SVG = `
<svg width="0" height="0" aria-hidden="true" focusable="false"
     style="position:absolute;width:0;height:0;overflow:hidden;pointer-events:none">
  <filter id="frost-refract" x="-15%" y="-15%" width="130%" height="130%"
          color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.006 0.009" numOctaves="2" seed="7" result="noise"/>
    <feGaussianBlur in="noise" stdDeviation="2.4" result="soft"/>
    <feDisplacementMap in="SourceGraphic" in2="soft" scale="14"
                       xChannelSelector="R" yChannelSelector="G"/>
  </filter>
</svg>`;

if (!document.getElementById('frost-refract')) {
  document.body.insertAdjacentHTML('afterbegin', FROST_SVG);
}

/* 从现有 data-world 反推初始状态 */
function readWorld() {
  const w = document.body.dataset.world || 'a';
  if (w === 'b') { STATE.mode = 'dark'; STATE.style = 'solid'; }
  else if (w === 'd') { STATE.mode = 'dark'; STATE.style = 'glass'; }
  else if (w === 'g') { STATE.mode = 'light'; STATE.style = 'glass'; }
  else { STATE.mode = 'light'; STATE.style = 'solid'; }
  if (STATE.style === 'glass') {
    const v = getComputedStyle(document.body).getPropertyValue('--glass-alpha').trim();
    if (v) STATE.glass = Math.round(parseFloat(v) * 100);
  }
}

/* 相对亮度：决定强调色上的文字用黑还是白 */
function lut(hex) {
  const m = hex.replace('#', '');
  const n = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function apply() {
  const b = document.body;
  b.dataset.world = WORLDS[`${STATE.mode}|${STATE.style}`] || 'a';
  b.dataset.fs = STATE.fs || 'm';
  const s = b.style;
  if (STATE.accent) {
    s.setProperty('--accent', STATE.accent);
    s.setProperty('--ring', STATE.accent);
    s.setProperty('--accent-soft', `color-mix(in oklab, ${STATE.accent} 14%, transparent)`);
    s.setProperty('--accent-fg', lut(STATE.accent) > 0.45 ? '#14130F' : '#FFFFFF');
  } else {
    ['--accent', '--ring', '--accent-soft', '--accent-fg'].forEach((k) => s.removeProperty(k));
  }
  // v12：透明度对「纸感」和「玻璃」都生效，所以两个版式都要写这个变量
  s.setProperty('--glass-alpha', (STATE.glass / 100).toFixed(2));

  if (STATE.image) {
    // v11：图片原样铺满，只在上面留一层很薄的压暗/提亮，保证字看得清。
    // 之前 .62 × .55 遮罩 × 面板自身不透明度三层相乘，图只剩一成可见 = 等于没放。
    s.setProperty('--bg-image', `url("${STATE.image}")`);
    s.setProperty('--bg-image-opacity', STATE.style === 'glass' ? '1' : '0.9');
    s.setProperty(
      '--bg-image-scrim',
      STATE.mode === 'dark' ? 'rgba(6,7,11,.20)' : 'rgba(250,248,243,.30)',
    );
    b.classList.add('has-image');
  } else {
    ['--bg-image', '--bg-image-opacity', '--bg-image-scrim'].forEach((k) => s.removeProperty(k));
    b.classList.remove('has-image');
  }

  // 控件回显
  $$('[data-axis="mode"] button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === STATE.mode)));
  $$('[data-axis="style"] button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === STATE.style)));
  $$('[data-axis="fs"] button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === STATE.fs)));
  $$('.sw[data-color]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.color === STATE.accent)));
  const r = $('#glassRange');
  if (r) {
    r.value = String(STATE.glass);
    const lo = Number(r.min || 0), hi = Number(r.max || 100);
    const n = Math.min(1, Math.max(0, (STATE.glass - lo) / (hi - lo)));
    r.style.setProperty('--pct', String(n));
    r.style.setProperty('--fill', `${(n * 100).toFixed(1)}%`);
    const out = $('#glassVal');
    if (out) out.textContent = `${STATE.glass}%`;
    const wrap = $('#glassField');
    if (wrap) wrap.style.opacity = '1';   // 纸感版也能调，不再置灰
  }
  const th = $('#bgThumb');
  if (th) {
    th.style.backgroundImage = STATE.image ? `url("${STATE.image}")` : '';
    th.innerHTML = STATE.image ? '' : '<i data-ico="image"></i>';
    if (window.upgradeIcons) window.upgradeIcons(th);
  }
  const rm = $('#bgRemove');
  if (rm) rm.disabled = !STATE.image;
  setPickLabel(!!STATE.image);
  try {
    localStorage.setItem('mem-theme', JSON.stringify(STATE));
  } catch {
    // 背景图是 base64，可能顶爆 localStorage 配额：退一步只存除图片外的设置，图片本次仍生效
    try { localStorage.setItem('mem-theme', JSON.stringify({ ...STATE, image: null })); } catch {}
    if (STATE.image) setNote('这张图太大，本次有效但没存住（换张小一点的）');
  }
}

function restore() {
  try {
    const raw = localStorage.getItem('mem-theme');
    if (!raw) return false;
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') {
      Object.assign(STATE, o);
      // 老版本存的是 object URL（blob:），刷新后必然失效，丢掉它
      if (STATE.image && !String(STATE.image).startsWith('data:')) STATE.image = null;
      return true;
    }
  } catch {}
  return false;
}

function wire() {
  $$('[data-axis] button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const axis = btn.closest('[data-axis]').dataset.axis;
      STATE[axis] = btn.dataset.v;
      apply();
    });
  });
  $$('.sw[data-color]').forEach((sw) => {
    sw.addEventListener('click', () => {
      STATE.accent = sw.dataset.color;
      apply();
    });
  });
  const custom = $('#customColor');
  if (custom) custom.addEventListener('input', () => { STATE.accent = custom.value; apply(); });
  const reset = $('#accentReset');
  if (reset) reset.addEventListener('click', () => { STATE.accent = ''; apply(); });
  const r = $('#glassRange');
  if (r) r.addEventListener('input', () => { STATE.glass = Number(r.value); apply(); });
  const file = $('#bgFile');
  if (file) {
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (f) importImage(f);
    });
  }
  const rm = $('#bgRemove');
  if (rm) rm.addEventListener('click', () => {
    if (STATE.image && String(STATE.image).startsWith('blob:')) URL.revokeObjectURL(STATE.image);
    STATE.image = null;
    apply();
    setNote(HINT0);
  });
}

// 背景图：先画进 canvas 缩到 1920 宽、压成 JPEG，再存 base64。
// （旧版用 object URL，刷新就失效 —— 用户会觉得「放进去了却看不见」。）
const HINT0 = '可以用你电脑里的图片；调低上面的透明度就能透出来';

function setNote(msg) {
  const f = $('#bgFile');
  const el = f && f.closest('.fld') && f.closest('.fld').querySelector('.lab span');
  if (el) el.textContent = msg;
}

// 「选择图片」/「换一张」跟着有没有图走
function setPickLabel(has) {
  const t = $('#bgPickText');
  if (t) t.textContent = has ? '换一张' : '选择图片';
}

function importImage(f) {
  const url = URL.createObjectURL(f);
  const img = new Image();
  setNote('正在处理这张图…');
  img.onload = () => {
    const scale = Math.min(1, 1920 / (img.naturalWidth || 1920));
    const w = Math.max(1, Math.round((img.naturalWidth || 1920) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || 1080) * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    let data = c.toDataURL('image/jpeg', 0.82);
    if (data.length > 3.6e6) data = c.toDataURL('image/jpeg', 0.6);
    if (STATE.image && String(STATE.image).startsWith('blob:')) URL.revokeObjectURL(STATE.image);
    STATE.image = data;
    apply();
    setPickLabel(true);
    const kb = Math.round((data.length * 3) / 4 / 1024);
    setNote(`已导入：${f.name}（${w}×${h} · ${kb} KB）· 刷新后还在`);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    setNote('这张图读不出来，换一张 jpg / png / webp');
  };
  img.src = url;
}

readWorld();
if (restore()) { /* 恢复上次选择 */ }
apply();
wire();
window.MEM_THEME = { STATE, apply };
