// The daily "one thing for me" check-in: commit to something in the morning,
// check it off in the evening, and see the pattern by month.

import * as D from './dates.js';
import { db, save } from './store.js';
import { TYPES } from './rules.js';
import { esc, ic } from './html.js';

export const CATEGORIES = {
  move:    { label: 'Move',    color: 'var(--accent)' },
  create:  { label: 'Create',  color: 'var(--climb)' },
  mind:    { label: 'Mind',    color: 'var(--walk)' },
  connect: { label: 'Connect', color: 'var(--run)' },
  rest:    { label: 'Rest',    color: 'var(--strength)' },
};

export const PRESETS = [
  { label: 'Read', icon: 'book', category: 'mind' },
  { label: 'Paint', icon: 'palette', category: 'create' },
  { label: 'Walk', icon: 'walk', category: 'move' },
  { label: 'Call a friend', icon: 'phone', category: 'connect' },
  { label: 'Slow morning', icon: 'coffee', category: 'rest' },
  { label: 'Journal', icon: 'notebook', category: 'mind' },
  { label: 'Cook something', icon: 'chef-hat', category: 'create' },
  { label: 'Play music', icon: 'music', category: 'create' },
  { label: 'Nap', icon: 'bed', category: 'rest' },
];

export const CATEGORY_ICON = { move: 'run', create: 'palette', mind: 'book', connect: 'heart', rest: 'coffee' };
export const MOODS = ['mood-sad', 'mood-empty', 'mood-smile', 'mood-happy', 'mood-heart'];

export function workoutsOn(date) {
  return (db.weeks[D.mondayOf(date)]?.days?.[date] || []).filter((w) => w.type !== 'rest');
}

// The day's check-in. If you didn't pick anything but finished a workout, that counts.
export function checkinFor(date) {
  const c = db.checkins?.[date];
  if (c) {
    const w = c.workoutId && workoutsOn(date).find((x) => x.id === c.workoutId);
    return w?.status === 'done' && c.status === 'committed' ? { ...c, status: 'done' } : c;
  }
  const w = workoutsOn(date).find((x) => x.status === 'done' && x.type !== 'stretch');
  return w ? { label: w.title, icon: TYPES[w.type].icon, category: 'move', status: 'done', workoutId: w.id, auto: true } : null;
}

export const isDone = (date) => checkinFor(date)?.status === 'done';

// Days in a row, counting today only once it's done.
export function streak(today = D.todayIso()) {
  let n = 0;
  for (let d = isDone(today) ? today : D.addDays(today, -1); isDone(d); d = D.addDays(d, -1)) n++;
  return n;
}

export function setCheckin(date, fields) {
  db.checkins = { ...db.checkins, [date]: { ...checkinFor(date), ...db.checkins?.[date], ...fields } };
  delete db.checkins[date].auto;
  save();
}

export function clearCheckin(date) {
  if (db.checkins) delete db.checkins[date];
  save();
}

export const streakText = (n) => (n ? `${n} ${n === 1 ? 'day' : 'days'} in a row` : '');

// ---------- view ----------

function choice(attrs, iconName, label, on) {
  return `<button class="chip ci-chip ${on ? 'on' : ''}" ${attrs}>${ic(iconName)} ${esc(label)}</button>`;
}

function pickCard(date, ui) {
  const sel = ui.ciPick;
  const planned = workoutsOn(date).filter((w) => w.status === 'planned' && w.type !== 'stretch');
  const isSel = (p) => sel && sel.label === p.label && sel.workoutId === p.workoutId;
  const custom = ui.ciCustom;
  return `
    <section class="card ci-card">
      <h2 class="ci-q">${date === D.todayIso() ? 'What\'s your one thing today?' : `What did you do for yourself ${D.DOW_LONG[D.dow(date)]}?`}</h2>
      ${planned.length ? `
        <p class="hint">From your plan</p>
        <div class="ci-chips">${planned.map((w) => {
          const p = { label: w.title, workoutId: w.id };
          return choice(`data-act="ci-pick" data-workout="${w.id}"`, TYPES[w.type].icon, w.title, isSel(p));
        }).join('')}</div>
        <p class="hint">Or something else</p>` : ''}
      <div class="ci-chips">
        ${PRESETS.map((p, i) => choice(`data-act="ci-pick" data-preset="${i}"`, p.icon, p.label, isSel(p))).join('')}
        ${choice('data-act="ci-custom"', 'pencil', 'Your own', custom)}
      </div>
      ${custom ? `
        <form data-form="ci-custom" class="ci-custom">
          <input name="label" placeholder="e.g. Pottery class" autocomplete="off" value="${esc(ui.ciCustomLabel || '')}">
          <div class="ci-chips">${Object.entries(CATEGORIES).map(([k, c]) => `
            <label class="type-pill" style="--c:${c.color}"><input type="radio" name="category" value="${k}" ${k === (ui.ciCustomCat || 'create') ? 'checked' : ''}><span>${ic(CATEGORY_ICON[k])} ${c.label}</span></label>`).join('')}
          </div>
          <button class="btn primary wide">${ic('lock')} Commit to it</button>
        </form>` : `
        <button class="btn primary wide" data-act="ci-commit" ${sel ? '' : 'disabled'}>${ic('lock')} ${sel ? `Commit to ${esc(sel.label.toLowerCase())}` : 'Pick one to commit'}</button>`}
    </section>`;
}

function committedCard(date, c) {
  const color = CATEGORIES[c.category]?.color || 'var(--accent)';
  return `
    <section class="card ci-card center">
      <p class="hint">You committed to</p>
      <div class="ci-big" style="--c:${color}">${ic(c.icon)} ${esc(c.label)}</div>
      <p class="hint">${date === D.todayIso() ? 'Come back tonight and check it off.' : ''}</p>
      <div class="row">
        <button class="btn primary" data-act="ci-done">${ic('check')} I did it</button>
        <button class="btn" data-act="ci-skip">Not today</button>
      </div>
      <button class="link" data-act="ci-change">Change my one thing</button>
    </section>`;
}

function doneCard(date, c) {
  const color = CATEGORIES[c.category]?.color || 'var(--accent)';
  return `
    <section class="card ci-card center ci-done">
      <div class="ci-check">${ic('check')}</div>
      <div class="ci-big" style="--c:${color}">${ic(c.icon)} ${esc(c.label)}</div>
      <p class="ci-sub">${c.auto ? 'Your workout counts. You showed up for yourself.' : 'You showed up for yourself.'}</p>
      <p class="hint">How do you feel?</p>
      <div class="ci-moods">${MOODS.map((m, i) => `<button class="ci-mood ${c.mood === i + 1 ? 'on' : ''}" data-act="ci-mood" data-mood="${i + 1}" aria-label="Mood ${i + 1} of 5">${ic(m)}</button>`).join('')}</div>
      <input class="ci-note" data-ci-note placeholder="Add a note (optional)" value="${esc(c.note || '')}">
      ${c.auto ? '' : '<button class="link" data-act="ci-undo">Undo</button>'}
    </section>`;
}

function skippedCard(c) {
  return `
    <section class="card ci-card center">
      <div class="ci-big muted">${ic(c.icon)} ${esc(c.label)}</div>
      <p class="ci-sub">Not today, and that's okay. Tomorrow's a fresh start.</p>
      <div class="row center-row">
        <button class="link" data-act="ci-done">Actually, I did it</button>
        <button class="link" data-act="ci-change">Pick something else</button>
      </div>
    </section>`;
}

function weekStrip(date) {
  const today = D.todayIso();
  const dots = D.weekDates(D.mondayOf(date)).map((d) => {
    const c = checkinFor(d);
    const done = c?.status === 'done';
    const color = done ? CATEGORIES[c.category]?.color : '';
    return `
      <button class="ci-dot ${done ? 'done' : ''} ${d === date ? 'sel' : ''} ${d > today ? 'future' : ''}" style="${color ? `--c:${color}` : ''}"
        ${d <= today ? `data-act="ci-date" data-date="${d}"` : 'disabled'} aria-label="${D.DOW_LONG[D.dow(d)]}">
        <span>${done ? ic('check') : ''}</span><small>${D.DOW[D.dow(d)][0]}</small>
      </button>`;
  }).join('');
  const n = streak();
  return `
    <section class="ci-week">
      <div class="ci-dots">${dots}</div>
      <p class="ci-streak">${n ? `${ic('flame')} ${streakText(n)} showing up for yourself` : 'Start a streak today.'}</p>
    </section>`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function monthView(month, date) {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const daysInMonth = new Date(y, m, 0).getDate();
  const lead = (D.dow(first) + 6) % 7; // Monday first
  const today = D.todayIso();
  const cells = [];
  let doneCount = 0;
  let pastCount = 0;
  const tally = {};
  for (let i = 1; i <= daysInMonth; i++) {
    const d = `${month}-${String(i).padStart(2, '0')}`;
    const c = checkinFor(d);
    const done = c?.status === 'done';
    if (d <= today) pastCount++;
    if (done) {
      doneCount++;
      const key = c.workoutId ? 'workouts' : c.label;
      tally[key] = (tally[key] || 0) + 1;
    }
    const color = done ? CATEGORIES[c.category]?.color : '';
    cells.push(`
      <button class="ci-cell ${done ? 'done' : ''} ${d === today ? 'today' : ''} ${d === date ? 'sel' : ''} ${d > today ? 'future' : ''}"
        style="${color ? `--c:${color}` : ''}" ${d <= today ? `data-act="ci-date" data-date="${d}"` : 'disabled'}>${i}</button>`);
  }
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, n]) => `${n} ${k === 'workouts' ? (n === 1 ? 'workout' : 'workouts') : k.toLowerCase()}`).join(' · ');
  return `
    <section class="card ci-month">
      <div class="ci-month-head">
        <button class="icon-sm" data-act="ci-month" data-delta="-1" aria-label="Previous month">${ic('chevron-left')}</button>
        <b>${MONTHS[m - 1]}</b>
        <button class="icon-sm" data-act="ci-month" data-delta="1" aria-label="Next month">${ic('chevron-right')}</button>
        <span class="ci-month-count">${doneCount} of ${pastCount} days</span>
      </div>
      <div class="ci-grid">
        ${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<span class="ci-wd">${d}</span>`).join('')}
        ${'<span></span>'.repeat(lead)}${cells.join('')}
      </div>
      <div class="ci-legend">${Object.values(CATEGORIES).map((c) => `<span><i style="background:${c.color}"></i>${c.label}</span>`).join('')}</div>
      ${top ? `<p class="ci-tally">${top}</p>` : ''}
    </section>`;
}

export function todayView(ui) {
  const today = D.todayIso();
  const date = ui.checkinDate || today;
  const c = checkinFor(date);
  const card = !c ? pickCard(date, ui) : c.status === 'committed' ? committedCard(date, c) : c.status === 'done' ? doneCard(date, c) : skippedCard(c);
  return `
    <div class="today">
      <div class="today-head">
        <h2>${date === today ? 'Today' : D.DOW_LONG[D.dow(date)]}</h2>
        <span>${D.shortDate(date)}</span>
        ${date !== today ? '<button class="link" data-act="ci-date" data-date="">Back to today</button>' : ''}
      </div>
      ${card}
      ${weekStrip(date)}
      ${monthView(ui.ciMonth || today.slice(0, 7), date)}
    </div>`;
}

// One line per day for the coach, e.g. "Mon: read (done)".
export function recentForCoach(today = D.todayIso()) {
  const lines = [];
  for (let i = 6; i >= 0; i--) {
    const d = D.addDays(today, -i);
    const c = checkinFor(d);
    if (c) lines.push(`${D.DOW[D.dow(d)]} ${d}: ${c.label} (${c.status})`);
  }
  return lines.join('\n');
}
