// The daily "something for me" check-in: commit to one or more things, check
// them off, and see the pattern by month.

import * as D from './dates.js';
import { db, save, uid } from './store.js';
import { TYPES } from './rules.js';
import { esc, ic } from './html.js';

export const CATEGORIES = {
  move:    { label: 'Move',    color: 'var(--accent)' },
  create:  { label: 'Create',  color: 'var(--climb)' },
  mind:    { label: 'Mind',    color: 'var(--walk)' },
  connect: { label: 'Connect', color: 'var(--run)' },
  rest:    { label: 'Rest',    color: 'var(--strength)' },
};

export const CATEGORY_ICON = { move: 'run', create: 'palette', mind: 'book', connect: 'heart', rest: 'coffee' };

const PRESETS = [
  { id: 'read', label: 'Read', icon: 'book', category: 'mind' },
  { id: 'paint', label: 'Paint', icon: 'palette', category: 'create' },
  { id: 'walk', label: 'Walk', icon: 'walk', category: 'move' },
  { id: 'call', label: 'Call a friend', icon: 'phone', category: 'connect' },
  { id: 'slow', label: 'Slow morning', icon: 'coffee', category: 'rest' },
  { id: 'journal', label: 'Journal', icon: 'notebook', category: 'mind' },
  { id: 'cook', label: 'Cook something', icon: 'chef-hat', category: 'create' },
  { id: 'music', label: 'Play music', icon: 'music', category: 'create' },
  { id: 'nap', label: 'Nap', icon: 'bed', category: 'rest' },
];

export const MOODS = ['mood-sad', 'mood-empty', 'mood-smile', 'mood-happy', 'mood-heart'];

// ---------- your list of options ----------

// Your options in your order; presets can be hidden, your own can be deleted.
export function allOptions() {
  if (!db.settings.ciOptions) db.settings.ciOptions = PRESETS.map((p) => ({ ...p }));
  return db.settings.ciOptions;
}

export const visibleOptions = () => allOptions().filter((o) => !o.hidden);

export function addOption(label, category) {
  const existing = allOptions().find((o) => o.label.toLowerCase() === label.toLowerCase());
  if (existing) {
    existing.hidden = false;
    save();
    return existing;
  }
  const option = { id: uid(), label, icon: CATEGORY_ICON[category], category, custom: true };
  allOptions().push(option);
  save();
  return option;
}

export function removeOption(id) {
  const list = allOptions();
  const o = list.find((x) => x.id === id);
  if (!o) return;
  if (o.custom) list.splice(list.indexOf(o), 1);
  else o.hidden = true;
  save();
}

export function moveOption(id, delta) {
  const list = allOptions();
  const visible = visibleOptions();
  const i = visible.findIndex((o) => o.id === id);
  const swapWith = visible[i + delta];
  if (!swapWith) return;
  const a = list.indexOf(visible[i]);
  const b = list.indexOf(swapWith);
  [list[a], list[b]] = [list[b], list[a]];
  save();
}

export function restoreHidden() {
  allOptions().forEach((o) => { o.hidden = false; });
  save();
}

// ---------- a day's check-in ----------

export function workoutsOn(date) {
  return (db.weeks[D.mondayOf(date)]?.days?.[date] || []).filter((w) => w.type !== 'rest');
}

// Older saves kept one thing per day; turn that into a one-item list.
function stored(date) {
  const raw = db.checkins?.[date];
  if (!raw) return null;
  if (raw.items) return raw;
  const { mood, note, ...item } = raw;
  const day = { items: [{ id: uid(), ...item }], mood, note };
  db.checkins[date] = day;
  return day;
}

// { items, mood, note }. Finished workouts count even if you didn't add them.
export function dayCheckin(date) {
  const day = stored(date);
  const workouts = workoutsOn(date);
  const items = (day?.items || []).map((it) => {
    const w = it.workoutId && workouts.find((x) => x.id === it.workoutId);
    return w?.status === 'done' && it.status === 'committed' ? { ...it, status: 'done' } : it;
  });
  for (const w of workouts) {
    if (w.status === 'done' && w.type !== 'stretch' && !items.some((it) => it.workoutId === w.id)) {
      items.push({ id: `auto-${w.id}`, label: w.title, icon: TYPES[w.type].icon, category: 'move', status: 'done', workoutId: w.id, auto: true });
    }
  }
  return { items, mood: day?.mood, note: day?.note };
}

export const isDone = (date) => dayCheckin(date).items.some((it) => it.status === 'done');

// Days in a row, counting today only once something is done.
export function streak(today = D.todayIso()) {
  let n = 0;
  for (let d = isDone(today) ? today : D.addDays(today, -1); isDone(d); d = D.addDays(d, -1)) n++;
  return n;
}

export const streakText = (n) => (n ? `${n} ${n === 1 ? 'day' : 'days'} in a row` : '');

function ensureDay(date) {
  db.checkins = db.checkins || {};
  return stored(date) || (db.checkins[date] = { items: [] });
}

export function addItems(date, items) {
  const day = ensureDay(date);
  for (const it of items) {
    if (day.items.some((x) => x.label === it.label && x.workoutId === it.workoutId)) continue;
    day.items.push({ id: uid(), ...it, status: 'committed', committedAt: Date.now() });
  }
  save();
}

// Update one item; an auto-counted workout becomes a real item the first time you touch it.
export function setItem(date, id, fields) {
  const day = ensureDay(date);
  let it = day.items.find((x) => x.id === id);
  if (!it) {
    const auto = dayCheckin(date).items.find((x) => x.id === id);
    if (!auto) return;
    const { auto: _, ...rest } = auto;
    it = { ...rest, id: uid() };
    day.items.push(it);
  }
  Object.assign(it, fields);
  save();
}

export function removeItem(date, id) {
  const day = ensureDay(date);
  day.items = day.items.filter((x) => x.id !== id);
  save();
}

export function setDay(date, fields) {
  Object.assign(ensureDay(date), fields);
  save();
}

export const itemFor = (date, id) => dayCheckin(date).items.find((x) => x.id === id);

// ---------- view ----------

function chip(attrs, iconName, label, on) {
  return `<button class="chip ci-chip ${on ? 'on' : ''}" ${attrs}>${ic(iconName)} ${esc(label)}</button>`;
}

function picker(date, ui, items) {
  const sel = ui.ciSel || new Set();
  const planned = workoutsOn(date).filter((w) => w.status === 'planned' && w.type !== 'stretch' && !items.some((it) => it.workoutId === w.id));
  const options = visibleOptions().filter((o) => !items.some((it) => it.label === o.label && !it.workoutId));
  const hidden = allOptions().filter((o) => o.hidden).length;

  if (ui.ciEdit) {
    return `
      <div class="ci-edit">
        <p class="hint">Reorder or remove your options.</p>
        ${visibleOptions().map((o, i, list) => `
          <div class="ci-edit-row">
            <span>${ic(o.icon)} ${esc(o.label)}</span>
            <button class="icon-sm" data-act="ci-opt-up" data-id="${o.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">${ic('chevron-up')}</button>
            <button class="icon-sm" data-act="ci-opt-down" data-id="${o.id}" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">${ic('chevron-down')}</button>
            <button class="icon-sm danger" data-act="ci-opt-remove" data-id="${o.id}" aria-label="${o.custom ? 'Delete' : 'Hide'} ${esc(o.label)}">${ic(o.custom ? 'trash' : 'eye-off')}</button>
          </div>`).join('')}
        ${hidden ? `<button class="link" data-act="ci-opt-restore">Show ${hidden} hidden ${hidden === 1 ? 'option' : 'options'}</button>` : ''}
        <button class="btn wide" data-act="ci-edit">Done editing</button>
      </div>`;
  }

  return `
    ${planned.length ? `
      <p class="hint">From your plan</p>
      <div class="ci-chips">${planned.map((w) => chip(`data-act="ci-pick" data-key="w:${w.id}"`, TYPES[w.type].icon, w.title, sel.has(`w:${w.id}`))).join('')}</div>
      <p class="hint">Or something else</p>` : ''}
    <div class="ci-chips">
      ${options.map((o) => chip(`data-act="ci-pick" data-key="o:${o.id}"`, o.icon, o.label, sel.has(`o:${o.id}`))).join('')}
      ${chip('data-act="ci-custom"', 'plus', 'Add your own', ui.ciCustom)}
    </div>
    ${ui.ciCustom ? `
      <form data-form="ci-custom" class="ci-custom">
        <input name="label" placeholder="e.g. Pottery class" autocomplete="off">
        <div class="ci-chips">${Object.entries(CATEGORIES).map(([k, c], i) => `
          <label class="type-pill" style="--c:${c.color}"><input type="radio" name="category" value="${k}" ${i === 1 ? 'checked' : ''}><span>${ic(CATEGORY_ICON[k])} ${c.label}</span></label>`).join('')}
        </div>
        <button class="btn wide">${ic('plus')} Add to my options</button>
      </form>` : ''}
    <div class="ci-actions">
      <button class="btn primary wide" data-act="ci-commit" ${sel.size ? '' : 'disabled'}>
        ${ic('lock')} ${sel.size ? `Commit to ${sel.size === 1 ? 'it' : `these ${sel.size}`}` : 'Pick what you\'ll do'}
      </button>
      <button class="link" data-act="ci-edit">Edit list</button>
    </div>`;
}

function itemRow(it) {
  const color = CATEGORIES[it.category]?.color || 'var(--accent)';
  const controls = it.status === 'committed'
    ? `<button class="btn small primary" data-act="ci-done" data-id="${it.id}">${ic('check')} Did it</button>
       <button class="btn small" data-act="ci-skip" data-id="${it.id}">Not today</button>`
    : it.status === 'done'
      ? `<span class="ci-state done">${ic('circle-check')} Done</span>${it.auto ? '' : `<button class="icon-sm" data-act="ci-undo" data-id="${it.id}" aria-label="Undo">${ic('arrow-back-up')}</button>`}`
      : `<span class="ci-state">Not today</span><button class="icon-sm" data-act="ci-undo" data-id="${it.id}" aria-label="Undo">${ic('arrow-back-up')}</button>`;
  return `
    <div class="ci-item s-${it.status}" style="--c:${color}">
      <span class="ci-item-icon">${ic(it.icon)}</span>
      <span class="ci-item-label">${esc(it.label)}</span>
      ${it.auto ? '' : `<button class="ci-remove" data-act="ci-remove" data-id="${it.id}" aria-label="Remove ${esc(it.label)}">${ic('x')}</button>`}
      <span class="ci-item-controls">${controls}</span>
    </div>`;
}

function dayCard(date, ui) {
  const { items, mood, note } = dayCheckin(date);
  const today = date === D.todayIso();
  const anyDone = items.some((it) => it.status === 'done');
  if (!items.length) {
    return `
      <section class="card ci-card">
        <h2 class="ci-q">${today ? 'What will you do for yourself today?' : `What did you do for yourself ${D.DOW_LONG[D.dow(date)]}?`}</h2>
        <p class="hint">Pick one or a few.</p>
        ${picker(date, ui, items)}
      </section>`;
  }
  return `
    <section class="card ci-card">
      <h2 class="ci-q">${today ? 'For you today' : `For you ${D.DOW_LONG[D.dow(date)]}`}</h2>
      <div class="ci-items">${items.map(itemRow).join('')}</div>
      ${ui.ciAdding ? `<div class="ci-add-more">${picker(date, ui, items)}</div>`
        : `<button class="ghost ci-add-btn" data-act="ci-add">${ic('plus')} Add something</button>`}
      ${anyDone ? `
        <div class="ci-feel">
          <p class="hint">How do you feel?</p>
          <div class="ci-moods">${MOODS.map((m, i) => `<button class="ci-mood ${mood === i + 1 ? 'on' : ''}" data-act="ci-mood" data-mood="${i + 1}" aria-label="Mood ${i + 1} of 5">${ic(m)}</button>`).join('')}</div>
          <input class="ci-note" data-ci-note placeholder="Add a note (optional)" value="${esc(note || '')}">
        </div>` : ''}
    </section>`;
}

function weekStrip(date) {
  const today = D.todayIso();
  const dots = D.weekDates(D.mondayOf(date)).map((d) => {
    const done = dayCheckin(d).items.filter((it) => it.status === 'done');
    const color = done.length ? CATEGORIES[done[0].category]?.color : '';
    return `
      <button class="ci-dot ${done.length ? 'done' : ''} ${d === date ? 'sel' : ''} ${d > today ? 'future' : ''}" style="${color ? `--c:${color}` : ''}"
        ${d <= today ? `data-act="ci-date" data-date="${d}"` : 'disabled'} aria-label="${D.DOW_LONG[D.dow(d)]}">
        <span>${done.length > 1 ? done.length : done.length ? ic('check') : ''}</span><small>${D.DOW[D.dow(d)][0]}</small>
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
  let doneDays = 0;
  let pastDays = 0;
  const tally = {};
  for (let i = 1; i <= daysInMonth; i++) {
    const d = `${month}-${String(i).padStart(2, '0')}`;
    const done = dayCheckin(d).items.filter((it) => it.status === 'done');
    if (d <= today) pastDays++;
    if (done.length) doneDays++;
    for (const it of done) {
      const key = it.workoutId ? 'workouts' : it.label;
      tally[key] = (tally[key] || 0) + 1;
    }
    const color = done.length ? CATEGORIES[done[0].category]?.color : '';
    cells.push(`
      <button class="ci-cell ${done.length ? 'done' : ''} ${d === today ? 'today' : ''} ${d === date ? 'sel' : ''} ${d > today ? 'future' : ''}"
        style="${color ? `--c:${color}` : ''}" ${d <= today ? `data-act="ci-date" data-date="${d}"` : 'disabled'}>${i}${done.length > 1 ? '<i></i>' : ''}</button>`);
  }
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, n]) => `${n} ${k === 'workouts' ? (n === 1 ? 'workout' : 'workouts') : k.toLowerCase()}`).join(' · ');
  return `
    <section class="card ci-month">
      <div class="ci-month-head">
        <button class="icon-sm" data-act="ci-month" data-delta="-1" aria-label="Previous month">${ic('chevron-left')}</button>
        <b>${MONTHS[m - 1]}</b>
        <button class="icon-sm" data-act="ci-month" data-delta="1" aria-label="Next month">${ic('chevron-right')}</button>
        <span class="ci-month-count">${doneDays} of ${pastDays} days</span>
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
  return `
    <div class="today">
      <div class="today-head">
        <h2>${date === today ? 'Today' : D.DOW_LONG[D.dow(date)]}</h2>
        <span>${D.shortDate(date)}</span>
        ${date !== today ? '<button class="link" data-act="ci-date" data-date="">Back to today</button>' : ''}
      </div>
      ${dayCard(date, ui)}
      ${weekStrip(date)}
      ${monthView(ui.ciMonth || today.slice(0, 7), date)}
    </div>`;
}

// For the coach: one line per day, e.g. "Mon 2026-10-19: Read (done), Call a friend (committed)".
export function recentForCoach(today = D.todayIso()) {
  const lines = [];
  for (let i = 6; i >= 0; i--) {
    const d = D.addDays(today, -i);
    const { items } = dayCheckin(d);
    if (items.length) lines.push(`${D.DOW[D.dow(d)]} ${d}: ${items.map((it) => `${it.label} (${it.status})`).join(', ')}`);
  }
  return lines.join('\n');
}
