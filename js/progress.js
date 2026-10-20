// The week as a trail: each active day is a marker on a switchback path, and
// finishing every day you planned reaches the summit.

import * as D from './dates.js';
import { db } from './store.js';
import { weekRunMiles, estimateMinutes } from './rules.js';

// Three legs joined by two rounded turns, drawn in a 160×130 box.
const TRAIL_D = 'M18 112 H130 A21 21 0 0 0 130 70 H30 A21 21 0 0 1 30 28 H124';
const SUMMIT = { x: 134, y: 28 };
const R = 21;
const PARTS = [
  { kind: 'line', from: [18, 112], to: [130, 112] },
  { kind: 'arc', cx: 130, cy: 91, from: Math.PI / 2, to: -Math.PI / 2 },
  { kind: 'line', from: [130, 70], to: [30, 70] },
  { kind: 'arc', cx: 30, cy: 49, from: Math.PI / 2, to: (3 * Math.PI) / 2 },
  { kind: 'line', from: [30, 28], to: [124, 28] },
].map((p) => ({ ...p, len: p.kind === 'line' ? Math.hypot(p.to[0] - p.from[0], p.to[1] - p.from[1]) : Math.PI * R }));
const TOTAL = PARTS.reduce((s, p) => s + p.len, 0);

function pointAt(f) {
  let dist = Math.max(0, Math.min(1, f)) * TOTAL;
  for (const p of PARTS) {
    if (dist <= p.len) {
      const t = dist / p.len;
      if (p.kind === 'line') return [p.from[0] + (p.to[0] - p.from[0]) * t, p.from[1] + (p.to[1] - p.from[1]) * t];
      const a = p.from + (p.to - p.from) * t;
      return [p.cx + R * Math.cos(a), p.cy + R * Math.sin(a)];
    }
    dist -= p.len;
  }
  return [124, 28];
}

// Progress is counted in days: each day with something planned is one marker on
// the trail, and it lights up when that day's workouts are done. Stretching is a
// bonus that never holds a day back. Skipped workouts leave the trail: changing
// your plan isn't failing it.
export function weekProgress(week) {
  const days = Object.keys(week?.days || {}).sort().flatMap((date) => {
    const items = week.days[date].filter((w) => w.type !== 'rest' && w.status !== 'skipped');
    if (!items.length) return [];
    const core = items.filter((w) => w.type !== 'stretch');
    return [{ date, done: (core.length ? core : items).every((w) => w.status === 'done') }];
  });
  const doneItems = Object.values(week?.days || {}).flat().filter((w) => w.status === 'done' && w.type !== 'rest');
  return { total: days.length, done: days.filter((d) => d.done).length, days, doneItems };
}

export function isSummit(week) {
  const { total, done } = weekProgress(week);
  return done >= 3 && done === total;
}

// Consecutive summited weeks ending with the week before `weekStart`
// (plus `weekStart` itself if it's already summited).
export function summitStreak(weekStart) {
  let streak = isSummit(db.weeks[weekStart]) ? 1 : 0;
  for (let ws = D.addDays(weekStart, -7); isSummit(db.weeks[ws]); ws = D.addDays(ws, -7)) streak++;
  return streak;
}

const markerAt = (i, n) => ((i + 0.5) / n) * 0.9;

export function trailSvg(week, { pop = null } = {}) {
  const { total, done, days } = weekProgress(week);
  const summit = done >= 3 && done === total;
  const reach = total === 0 || done === 0 ? 0 : summit ? 100 : markerAt(done - 1, total) * 100;
  const markers = days.map((d, i) => {
    const [x, y] = pointAt(markerAt(i, total));
    // Labels sit above the bottom and top legs, and beside the turns.
    const onTurn = Math.abs(y - 112) > 2 && Math.abs(y - 70) > 2 && Math.abs(y - 28) > 2;
    const [lx, ly] = onTurn ? [x + (x > 80 ? 11 : -11), y + 3] : [x, y - 9];
    return `
      <circle class="marker ${d.done ? 'done' : ''} ${pop === d.date ? 'pop' : ''}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${d.done ? 5.5 : 4.5}"/>
      <text class="marker-label ${d.done ? 'done' : ''}" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${D.DOW[D.dow(d.date)]}</text>`;
  }).join('');
  return `
    <svg class="trail ${summit ? 'summited' : ''}" viewBox="0 0 160 130" role="img" aria-label="${done} of ${total} days done">
      <path d="${TRAIL_D}" class="trail-base"/>
      ${reach > 0 ? `<path d="${TRAIL_D}" class="trail-done" pathLength="100" stroke-dasharray="${reach.toFixed(1)} 100"/>` : ''}
      ${markers}
      ${summit ? `<circle class="summit-halo" cx="${SUMMIT.x}" cy="${SUMMIT.y}" r="13"/>` : ''}
      <circle class="summit" cx="${SUMMIT.x}" cy="${SUMMIT.y}" r="8"/>
    </svg>`;
}

const daysWord = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;

export function trailMessage(week) {
  const { total, done } = weekProgress(week);
  if (!total) return 'Plan your week to map out the climb.';
  if (done >= 3 && done === total) return 'Summit reached. Every day done.';
  if (done === 0) return `${daysWord(total)} to the summit`;
  if (done * 2 >= total && (done - 1) * 2 < total) return 'Halfway up. Keep climbing.';
  return `${daysWord(total - done)} to the summit`;
}

// A short, progress-aware cheer for the moment you mark something done on `date`.
export function doneCheer(week, date) {
  const { total, done, days } = weekProgress(week);
  const day = D.DOW_LONG[D.dow(date)];
  if (!days.find((d) => d.date === date)?.done) return `Nice work. Finish the rest of ${day} to light up its marker.`;
  if (done >= 3 && done === total) return 'Summit! Every day this week is done.';
  if (done * 2 >= total && (done - 1) * 2 < total) return `${day} done. Halfway up the trail.`;
  return `${day} done. ${daysWord(total - done)} to the summit.`;
}

export function weekTotals(week) {
  const { doneItems } = weekProgress(week);
  return {
    workouts: doneItems.length,
    miles: weekRunMiles(week, { doneOnly: true }),
    elevation: doneItems.reduce((s, w) => s + (Number(w.elevationFt) || 0), 0),
    minutes: doneItems.reduce((s, w) => s + estimateMinutes(w), 0),
  };
}
