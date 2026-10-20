// The week as a trail: each workout is a marker on a switchback path, and
// finishing every workout you kept on the plan reaches the summit.

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

// Skipped workouts leave the trail: changing your plan isn't failing it.
export function weekProgress(week) {
  const items = Object.values(week?.days || {}).flat().filter((w) => w.type !== 'rest' && w.status !== 'skipped');
  const done = items.filter((w) => w.status === 'done');
  return { total: items.length, done: done.length, doneItems: done };
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

export function trailSvg(week, { pop = false } = {}) {
  const { total, done } = weekProgress(week);
  const summit = done >= 3 && done === total;
  const reach = total === 0 || done === 0 ? 0 : summit ? 100 : markerAt(done - 1, total) * 100;
  const markers = Array.from({ length: total }, (_, i) => {
    const [x, y] = pointAt(markerAt(i, total));
    const isDone = i < done;
    return `<circle class="marker ${isDone ? 'done' : ''} ${pop && i === done - 1 ? 'pop' : ''}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${isDone ? 5.5 : 4.5}"/>`;
  }).join('');
  return `
    <svg class="trail ${summit ? 'summited' : ''}" viewBox="0 0 160 130" role="img" aria-label="${done} of ${total} workouts done">
      <path d="${TRAIL_D}" class="trail-base"/>
      ${reach > 0 ? `<path d="${TRAIL_D}" class="trail-done" pathLength="100" stroke-dasharray="${reach.toFixed(1)} 100"/>` : ''}
      ${markers}
      ${summit ? `<circle class="summit-halo" cx="${SUMMIT.x}" cy="${SUMMIT.y}" r="13"/>` : ''}
      <circle class="summit" cx="${SUMMIT.x}" cy="${SUMMIT.y}" r="8"/>
    </svg>`;
}

export function trailMessage(week) {
  const { total, done } = weekProgress(week);
  if (!total) return 'Plan your week to map out the climb.';
  if (done >= 3 && done === total) return 'Summit reached. Every workout done.';
  if (done === 0) return `${total} markers to the summit`;
  if (done === 1) return 'First steps on the trail';
  if (done * 2 >= total && (done - 1) * 2 < total) return 'Halfway up. Keep climbing.';
  const left = total - done;
  return `${left} more to the summit`;
}

// A short, progress-aware cheer for the moment you mark something done.
export function doneCheer(week) {
  const { total, done } = weekProgress(week);
  if (done >= 3 && done === total) return 'Summit! Every workout this week is done.';
  if (done === 1) return 'First marker of the week. Nice start.';
  if (done * 2 >= total && (done - 1) * 2 < total) return `Halfway up — ${done} of ${total} done.`;
  return `Nice work — ${done} of ${total} done.`;
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
