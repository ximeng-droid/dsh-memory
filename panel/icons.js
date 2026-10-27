/* 图标（自绘 16px 网格 / 1.6 stroke）+ 原型交互
   —— 不用 emoji、不用 unicode 符号替代图标 */
(function () {
  const SPRITE = `
<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">
  <symbol id="i-mark" viewBox="0 0 16 16"><path d="M8 2.2 9.7 6l3.9 1.3-3.3 2.4.4 4-2.7-2-2.7 2 .4-4L2.4 7.3 6.3 6 8 2.2Z" fill="currentColor" stroke="none"/></symbol>
  <symbol id="i-inbox" viewBox="0 0 16 16"><path d="M2.4 9.2h2.9l.9 1.6h3.6l.9-1.6h2.9M2.4 9.2 4.3 3.6h7.4l1.9 5.6v3.2H2.4V9.2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-stack" viewBox="0 0 16 16"><path d="M8 2.4 14 5.6 8 8.8 2 5.6 8 2.4Zm6 6L8 11.6 2 8.4M14 11 8 14.2 2 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-tag" viewBox="0 0 16 16"><path d="M7.3 2.4H13v5.7l-6.2 6.2-5.7-5.7 6.2-6.2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="10.6" cy="5.2" r="1" fill="currentColor"/></symbol>
  <symbol id="i-folder" viewBox="0 0 16 16"><path d="M2.4 5.1h3.4l1.2 1.5h6.6v6.2H2.4V5.1Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M2.4 5.1V3.4h4l1 1.7" fill="none" stroke="currentColor" stroke-width="1.6"/></symbol>
  <symbol id="i-cal" viewBox="0 0 16 16"><rect x="2.6" y="3.6" width="10.8" height="9.8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M2.6 6.6h10.8M5.6 2.4v2.4M10.4 2.4v2.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></symbol>
  <symbol id="i-trash" viewBox="0 0 16 16"><path d="M3.2 5h9.6M6.2 5V3.4h3.6V5m-5.4 0 .7 8h6.8l.7-8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-search" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m10.2 10.2 3.2 3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></symbol>
  <symbol id="i-plus" viewBox="0 0 16 16"><path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></symbol>
  <symbol id="i-gear" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 1.9v1.6M8 12.5v1.6M2.6 8h1.5M11.9 8h1.5M4.2 4.2l1.1 1.1M10.7 10.7l1.1 1.1M11.8 4.2l-1.1 1.1M5.3 10.7l-1.1 1.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></symbol>
  <symbol id="i-help" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.4 6.3c0-1 .7-1.6 1.6-1.6s1.6.6 1.6 1.5c0 1.4-1.6 1.4-1.6 2.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.2" r=".85" fill="currentColor"/></symbol>
  <symbol id="i-check" viewBox="0 0 16 16"><path d="m3.4 8.4 3 3 6.2-6.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-x" viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></symbol>
  <symbol id="i-pencil" viewBox="0 0 16 16"><path d="M10.6 2.9 13.1 5.4 5.9 12.6 3 13.2l.6-2.9 7-7.4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></symbol>
  <symbol id="i-graph" viewBox="0 0 16 16"><circle cx="8" cy="3.6" r="1.7" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="3.6" cy="12" r="1.7" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12.4" cy="12" r="1.7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7.2 5.1 4.3 10.5M8.8 5.1l2.9 5.4M5.3 12h5.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></symbol>
  <symbol id="i-copy" viewBox="0 0 16 16"><rect x="5.4" y="5.4" width="7.2" height="7.2" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.4 10.6V4.4c0-.6.4-1 1-1h6.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></symbol>
  <symbol id="i-chev" viewBox="0 0 16 16"><path d="m5 6.5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-down" viewBox="0 0 16 16"><path d="M8 3.4v9M4.4 8.8 8 12.4l3.6-3.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-image" viewBox="0 0 16 16"><rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="5.9" cy="6.6" r="1.1" fill="currentColor"/><path d="M3.6 11.6 6.9 8.4l2.1 2.1 1.8-1.6 1.6 2.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>\n  <symbol id="i-filter" viewBox="0 0 16 16"><path d="M2.6 4h10.8L9.2 8.6v3.9L6.8 13V8.6L2.6 4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></symbol>
</svg>`;

  window.upgradeIcons = (root) => {
    (root || document).querySelectorAll('[data-ico]').forEach((el) => {
      const name = el.getAttribute('data-ico');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'i');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('viewBox', '0 0 16 16');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#i-' + name);
      svg.appendChild(use);
      el.replaceWith(svg);
    });
  };
  // app.js 用 __dshIcons 这个名字调用（动态渲染后升级图标），这里给个别名，避免两边名字对不上
  window.__dshIcons = window.upgradeIcons;

  const mount = () => {
    const d = document.createElement('div');
    d.id = 'impeccable-sprite';
    d.innerHTML = SPRITE;
    document.body.prepend(d);

    // 所有 <i data-ico="gear"> 升级成真实 SVG
    document.querySelectorAll('[data-ico]').forEach((el) => {
      const name = el.getAttribute('data-ico');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'i');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('viewBox', '0 0 16 16');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#i-' + name);
      svg.appendChild(use);
      el.replaceWith(svg);
    });

    // ---- 设置抽屉 ----
    const drawer = document.getElementById('settings');
    const scrim = document.getElementById('scrim');
    const opener = document.getElementById('openSettings');
    const closers = drawer ? drawer.querySelectorAll('[data-close]') : [];
    const setOpen = (on) => {
      if (!drawer) return;
      drawer.classList.toggle('on', on);
      scrim && scrim.classList.toggle('on', on);
      if (opener) opener.setAttribute('aria-expanded', String(on));
      drawer.setAttribute('aria-hidden', String(!on));
      drawer.tabIndex = -1;
      if (on) drawer.focus({ preventScroll: true });
    };
    document.querySelectorAll('[data-open-settings]').forEach((b) => b.addEventListener('click', () => setOpen(!drawer.classList.contains('on'))));
    if (scrim) scrim.addEventListener('click', () => setOpen(false));
    closers.forEach((c) => c.addEventListener('click', () => setOpen(false)));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(false);
      // J / K 上下选行
      if (e.key === 'j' || e.key === 'k') {
        const rows = [...document.querySelectorAll('[data-row]')];
        const i = rows.findIndex((r) => r.getAttribute('aria-selected') === 'true');
        const next = e.key === 'j' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
        rows.forEach((r, n) => r.setAttribute('aria-selected', String(n === next)));
        rows[next] && rows[next].scrollIntoView({ block: 'nearest' });
      }
    });

    if (document.body.dataset.openSettings) setOpen(true);

    // ---- 选中行 ----
    document.querySelectorAll('[data-row]').forEach((row) => {
      const pick = () => {
        document.querySelectorAll('[data-row]').forEach((r) => r.setAttribute('aria-selected', 'false'));
        row.setAttribute('aria-selected', 'true');
        const on = document.querySelector('.detail');
        if (on && window.matchMedia('(max-width:1000px)').matches) on.classList.add('on');
      };
      row.addEventListener('click', pick);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    });

    // ---- 类型筛选 chip ----
    document.querySelectorAll('[data-chip]').forEach((c) => {
      c.addEventListener('click', () => {
        const group = c.parentElement;
        group.querySelectorAll('[data-chip]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
        c.setAttribute('aria-pressed', 'true');
      });
    });

    // ---- 分段控件 / 开关 ----
    document.querySelectorAll('[data-seg]').forEach((s) => {
      s.querySelectorAll('button').forEach((b) => {
        b.addEventListener('click', () => {
          s.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
          b.setAttribute('aria-pressed', 'true');
        });
      });
    });
    document.querySelectorAll('[data-switch]').forEach((s) => {
      s.addEventListener('click', () => {
        s.setAttribute('aria-checked', s.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
      });
    });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
