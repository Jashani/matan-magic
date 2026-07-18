'use strict';

// ── Shared DOM/utility helpers used by both app.js and random.js ───────────────
const $ = id => document.getElementById(id);

const show = el => el.classList.remove('hidden');
const hide = el => el.classList.add('hidden');
const esc  = s  => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function downloadBlob(content, filename, mime) {
  const url = URL.createObjectURL(new Blob([content], {type: mime}));
  Object.assign(document.createElement('a'), {href: url, download: filename}).click();
  URL.revokeObjectURL(url);
}

function spawnConfetti(pieces) {
  for (let i = 0; i < 16; i++) {
    const el  = document.createElement('div');
    el.className = 'confetti-piece';
    el.textContent = pieces[Math.floor(Math.random() * pieces.length)];
    const delay = Math.random() * 0.7;
    const dur   = 1.8 + Math.random() * 1;
    el.style.cssText =
      `left:${3 + Math.random() * 94}vw;` +
      `animation-delay:${delay}s;` +
      `animation-duration:${dur}s;` +
      `font-size:${0.9 + Math.random() * 0.9}rem`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), (delay + dur + 0.2) * 1000);
  }
}
