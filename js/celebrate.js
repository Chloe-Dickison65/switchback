// A full-screen "yay" moment: confetti, a check that draws itself, and a message.

import { ic } from './html.js';

const COLORS = ['var(--accent)', 'var(--sun)', 'var(--run)', 'var(--climb)', 'var(--walk)'];

// lines: HTML <li> items. badge: short text shown in a yellow pill with badgeIcon.
export function celebrate({ title, lines = '', sub = '', badge = '', badgeIcon = 'lock' }) {
  const confetti = Array.from({ length: 36 }, (_, i) => {
    const angle = (i / 36) * Math.PI * 2 + Math.random() * 0.4;
    const dist = 120 + Math.random() * 140;
    return `<i style="--x:${Math.cos(angle) * dist}px;--y:${Math.sin(angle) * dist - 60}px;--r:${Math.random() * 540 - 270}deg;background:${COLORS[i % COLORS.length]};animation-delay:${Math.random() * 0.12}s"></i>`;
  }).join('');
  const el = document.createElement('div');
  el.className = 'lockin';
  el.innerHTML = `
    <div class="lockin-card">
      <div class="confetti">${confetti}</div>
      <svg class="lockin-check" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24"/><path d="M15 27l7 7 15-16"/></svg>
      <h2>${title}</h2>
      ${lines ? `<ul>${lines}</ul>` : ''}
      ${sub ? `<p class="lockin-sub">${sub}</p>` : ''}
      ${badge ? `<p class="lockin-count">${ic(badgeIcon)} ${badge}</p>` : ''}
    </div>`;
  document.body.appendChild(el);
  navigator.vibrate?.([30, 60, 30, 60, 90]);
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  el.addEventListener('click', close);
  setTimeout(close, 3200);
}

export const pick = (list) => list[Math.floor(Math.random() * list.length)];
