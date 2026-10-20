import * as D from './dates.js';
import { db, save, getWeek, dayWorkouts, hasPlan, exportData, importData } from './store.js';
import { TYPES, TYPE_KEYS, workout, warningsFor, isOfficeDay, starterWeek, summary, weekRunMiles, workoutWindow } from './rules.js';
import * as Cal from './calendar.js';
import * as Coach from './coach.js';
import * as P from './progress.js';
import { enableDrag } from './drag.js';
import * as W from './weather.js';
import { esc, ic } from './html.js';
import { celebrate, pick } from './celebrate.js';
import * as T from './today.js';

const ui = {
  view: 'week',
  weekStart: D.defaultWeekStart(),
  sheet: null,   // { kind: 'workout' | 'add', date, id }
  busy: false,
  pending: '',
  draft: '',
  chatError: '',
  toast: '',
  calState: '',  // '' | 'loading' | 'error'
  syncing: false,
  checkinDate: null, // Today tab: which day you're checking in for (null = today)
  ciSel: new Set(),  // options tapped in the picker but not committed to yet
  ciCustom: false,   // showing the "add your own" form
  ciAdding: false,   // showing the picker to add more to a day that has items
  ciEdit: false,     // editing your list of options
  ciMonth: null,     // 'YYYY-MM' shown in the month view
};

const $app = document.getElementById('app');
const TRAIL_MARK = '<svg viewBox="0 0 512 512" aria-hidden="true"><path d="M150 388H342A60 60 0 0 0 342 268H170A60 60 0 0 1 170 148H342" fill="none" stroke="#1f7a4d" stroke-width="48" stroke-linecap="round" stroke-linejoin="round"/><circle cx="342" cy="148" r="46" fill="#f5b400"/></svg>';
const FEELS = ['😵', '😓', '🙂', '😄', '🔥'];

// ---------- helpers ----------

const calendarFor = (ws) => db.calCache[ws] || null;
const officeFn = (ws) => (date) => isOfficeDay(date, db.settings, calendarFor(ws));

function currentWarnings(ws) {
  return warningsFor(ws, getWeek(ws), db.settings, calendarFor(ws), db.weeks[D.addDays(ws, -7)]);
}

function findWorkout(date, id) {
  return dayWorkouts(D.mondayOf(date), date).find((w) => w.id === id);
}

let toastTimer;
function toast(msg) {
  ui.toast = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast = ''; document.querySelector('.toast')?.remove(); }, 3500);
  render();
}

function changed(ws, note) {
  const week = getWeek(ws);
  if (note) week.manualChange = [week.manualChange, note].filter(Boolean).join(' ');
  week.synced = false;
  save();
  queueSync(ws);
}

// ---------- calendar ----------

async function refreshCalendar(ws, { quiet = true } = {}) {
  if (!Cal.isConnected()) return;
  ui.calState = 'loading';
  render({ background: true });
  try {
    db.calCache[ws] = await Cal.fetchWeek(ws);
    // Keep only a few weeks of cached events.
    for (const k of Object.keys(db.calCache)) if (k < D.addDays(D.mondayOf(D.todayIso()), -14)) delete db.calCache[k];
    save();
    ui.calState = '';
  } catch (e) {
    ui.calState = 'error';
    if (!quiet || !(e instanceof Cal.AuthNeeded)) toast(e.message);
  }
  render({ background: true });
}

let syncTimer;
function queueSync(ws) {
  if (!Cal.isConnected()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(ws), 1500);
}

async function syncNow(ws) {
  if (ui.syncing) return queueSync(ws);
  ui.syncing = true;
  render({ background: true });
  try {
    await Cal.syncWeek(ws, getWeek(ws));
    getWeek(ws).synced = true;
    save();
  } catch (e) {
    toast(e instanceof Cal.AuthNeeded ? 'Google session expired — tap Connect at the top.' : `Calendar sync failed: ${e.message}`);
  } finally {
    ui.syncing = false;
    render({ background: true });
  }
}

async function connectCalendar() {
  try {
    await Cal.connect();
    toast('Google Calendar connected ✓');
    await refreshCalendar(ui.weekStart, { quiet: false });
    if (hasPlan(ui.weekStart)) await syncNow(ui.weekStart);
  } catch (e) {
    toast(e.message);
  }
}

// ---------- coach ----------

// Apply the coach's plan. Your own changes always win: locked-in days and
// pinned workouts (ones you moved, retimed, edited or added) are never touched.
function applyPlan(ws, days) {
  const week = getWeek(ws);
  const today = D.todayIso();
  const valid = new Set(D.weekDates(ws));
  // A pinned workout lives where you put it, so the coach can't add a copy elsewhere.
  const pinnedTitles = new Set(Object.values(week.days).flat()
    .filter((w) => w.pinned && w.status === 'planned').map((w) => w.title.toLowerCase()));
  for (const day of days) {
    if (!valid.has(day.date) || day.date < today) continue; // the past is the past
    if (isCommitted(day.date)) continue;
    const old = week.days[day.date] || [];
    const kept = old.filter((w) => w.status !== 'planned' || w.pinned);
    const pool = old.filter((w) => w.status === 'planned' && !w.pinned);
    const fresh = day.workouts
      .filter((nw) => !kept.some((k) => k.type === nw.type) && !pinnedTitles.has(nw.title.toLowerCase()))
      .map((nw) => {
        const i = pool.findIndex((p) => p.type === nw.type); // reuse ids so calendar events update in place
        const id = i >= 0 ? pool.splice(i, 1)[0].id : undefined;
        return workout({
          ...(id ? { id } : {}),
          type: nw.type, title: nw.title, detail: nw.detail,
          distanceMi: nw.distance_mi, minutes: nw.minutes, timeOfDay: nw.time_of_day,
          startTime: /^\d{2}:\d{2}/.test(nw.start_time || '') ? nw.start_time.slice(0, 5) : null,
          intensity: nw.intensity,
        });
      });
    week.days[day.date] = [...kept, ...fresh];
  }
}

function addLogEntry(e) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date) || e.date > D.todayIso()) return;
  const list = dayWorkouts(D.mondayOf(e.date), e.date);
  const planned = list.find((w) => w.type === e.type && w.status === 'planned');
  const fields = {
    status: 'done', title: e.title, distanceMi: e.distance_mi, elevationFt: e.elevation_ft,
    minutes: e.minutes, feel: e.feel, note: e.note, intensity: e.type === 'hike' && (e.elevation_ft || 0) >= 1500 ? 'hard' : 'moderate',
  };
  if (planned) Object.assign(planned, fields);
  else if (!list.some((w) => w.type === e.type && w.status === 'done')) list.push(workout({ type: e.type, source: 'logged', ...fields }));
}

// Show the coach's words as they arrive, without re-rendering the whole screen.
function liveReplyHtml() {
  return ui.liveReply
    ? `<p>${esc(ui.liveReply)}</p><div class="msg-meta"><span>Updating your plan…</span></div>`
    : '<i></i><i></i><i></i>';
}

function showLiveReply(text) {
  ui.liveReply = text;
  const el = document.getElementById('live');
  if (!el) return;
  el.classList.remove('typing');
  el.innerHTML = liveReplyHtml();
  scrollChat();
}

async function sendToCoach(text, { mode = 'plan' } = {}) {
  text = text.trim();
  if (!text || ui.busy) return;
  const ws = ui.weekStart;
  ui.busy = true;
  ui.pending = text;
  ui.draft = '';
  ui.chatError = '';
  ui.view = 'coach';
  render();
  try {
    if (Cal.isConnected() && !calendarFor(ws)) await refreshCalendar(ws);
    const res = await Coach.ask({
      weekStart: ws, text, calendar: calendarFor(ws), isOffice: officeFn(ws), warnings: currentWarnings(ws),
      onReply: showLiveReply, mode,
    });
    const chat = (db.chats[ws] ||= []);
    chat.push({ role: 'user', text, ts: Date.now() });
    chat.push({
      role: 'assistant', text: res.reply, ts: Date.now(), cost: res.cost, planChanged: !!res.days, logged: res.logEntries.length,
      ...(res.review ? { proposal: newProposal(ws, res.review) } : {}),
    });
    res.logEntries.forEach(addLogEntry);
    for (const { date, office } of res.officeOverrides) setOfficeDay(date, office);
    if (res.days) {
      applyPlan(ws, res.days);
      getWeek(ws).manualChange = '';
      getWeek(ws).synced = false;
      queueSync(ws);
    }
    save();
  } catch (e) {
    ui.chatError = e.message;
    ui.draft = text;
  } finally {
    ui.busy = false;
    ui.pending = '';
    ui.liveReply = '';
    render();
    scrollChat();
  }
}

// ---------- coach review of your changes ----------

// What a proposed day would change: planned workouts the coach can touch, before vs after.
function dayDiff(ws, day) {
  const current = (getWeek(ws).days[day.date] || []).filter((w) => w.status === 'planned' && !w.pinned);
  const pinned = new Set((getWeek(ws).days[day.date] || []).filter((w) => w.pinned).map((w) => w.title.toLowerCase()));
  const proposed = day.workouts.filter((w) => !pinned.has(w.title.toLowerCase()));
  const key = (w) => `${w.type}|${w.title.toLowerCase()}`;
  const removed = current.filter((w) => !proposed.some((p) => key(p) === key(w)));
  const added = proposed.filter((p) => !current.some((w) => key(p) === key(w)));
  return { removed, added };
}

function newProposal(ws, { flags, days }) {
  const today = D.todayIso();
  const useful = days.filter((d) => d.date >= today && !isCommitted(d.date) && D.mondayOf(d.date) === ws)
    .filter((d) => { const { removed, added } = dayDiff(ws, d); return removed.length || added.length; });
  const proposal = { ws, flags, days: useful, useFlag: flags.map(() => false), takeDay: useful.map(() => true), status: 'pending' };
  if (!flags.length && !useful.length) {
    proposal.status = 'clean';
    getWeek(ws).manualChange = '';
  }
  return proposal;
}

function proposalCard(m, i) {
  const p = m.proposal;
  if (p.status === 'clean') return `<div class="proposal done">${ic('circle-check')} Your changes look good. Nothing to adjust.</div>`;
  if (p.status !== 'pending') {
    return `<div class="proposal done">${ic(p.status === 'applied' ? 'circle-check' : 'x')} ${p.status === 'applied' ? `Applied ${p.appliedCount} ${p.appliedCount === 1 ? 'change' : 'changes'}` : 'Dismissed. Nothing changed.'}</div>`;
  }
  const dayName = (d) => D.DOW_LONG[D.dow(d)];
  const flags = p.flags.map((f, j) => `
    <div class="prop-flag">
      <p class="prop-issue">${ic('alert-triangle')} <b>${esc(f.workout_title)}</b> on ${dayName(f.date)}: ${esc(f.issue)}</p>
      <p class="prop-suggest">${esc(f.suggestion)}</p>
      <div class="seg">
        <button class="${p.useFlag[j] ? '' : 'on'}" data-act="prop-flag" data-msg="${i}" data-i="${j}" data-use="0">Keep mine</button>
        ${f.move_to_date ? `<button class="${p.useFlag[j] ? 'on' : ''}" data-act="prop-flag" data-msg="${i}" data-i="${j}" data-use="1">Move to ${D.DOW[D.dow(f.move_to_date)]}${f.move_to_time ? ` ${D.prettyTime(f.move_to_time.slice(0, 5))}` : ''}</button>` : ''}
      </div>
    </div>`).join('');
  const days = p.days.map((d, j) => {
    const { removed, added } = dayDiff(p.ws, d);
    const parts = [
      ...removed.map((w) => `<span class="minus">${ic('minus')} ${esc(w.title)}</span>`),
      ...added.map((w) => `<span class="plus">${ic('plus')} ${esc(w.title)}${w.distance_mi ? ` · ${w.distance_mi} mi` : w.minutes ? ` · ${w.minutes} min` : ''}</span>`),
    ];
    return `
      <label class="prop-day">
        <input type="checkbox" data-act-change="prop-day" data-msg="${i}" data-i="${j}" ${p.takeDay[j] ? 'checked' : ''}>
        <b>${D.DOW[D.dow(d.date)]}</b><span class="prop-parts">${parts.join('')}</span>
      </label>`;
  }).join('');
  const count = p.useFlag.filter(Boolean).length + p.takeDay.filter(Boolean).length;
  return `
    <div class="proposal">
      ${flags ? `<h4>About your changes</h4>${flags}` : `<p class="prop-ok">${ic('circle-check')} Your changes work with your recovery.</p>`}
      ${days ? `<h4>Suggested adjustments</h4>${days}` : ''}
      <div class="row">
        <button class="btn primary" data-act="prop-apply" data-msg="${i}" ${count ? '' : 'disabled'}>${ic('check')} Apply ${count || ''}</button>
        <button class="btn" data-act="prop-dismiss" data-msg="${i}">Dismiss</button>
      </div>
    </div>`;
}

function applyProposal(p) {
  const week = getWeek(p.ws);
  let applied = 0;
  // Accepted suggestions for your own changes: move that workout (it stays pinned; you approved it).
  p.flags.forEach((f, j) => {
    if (!p.useFlag[j] || !f.move_to_date || D.mondayOf(f.move_to_date) !== p.ws) return;
    const list = week.days[f.date] || [];
    const w = list.find((x) => x.status === 'planned' && x.title.toLowerCase() === f.workout_title.toLowerCase());
    if (!w) return;
    list.splice(list.indexOf(w), 1);
    (week.days[f.move_to_date] ||= []).push(w);
    if (/^\d{2}:\d{2}/.test(f.move_to_time || '')) w.startTime = f.move_to_time.slice(0, 5);
    applied++;
  });
  const days = p.days.filter((_, j) => p.takeDay[j]);
  applyPlan(p.ws, days);
  applied += days.length;
  week.manualChange = '';
  week.synced = false;
  save();
  queueSync(p.ws);
  return applied;
}


function startPlanning() {
  const ws = ui.weekStart;
  if (!db.settings.anthropicKey.trim()) {
    if (!hasPlan(ws)) {
      const starter = starterWeek(ws, db.settings, calendarFor(ws), db.weeks[D.addDays(ws, -7)]);
      for (const [date, list] of Object.entries(starter)) {
        if (date >= D.todayIso()) dayWorkouts(ws, date).push(...list);
      }
      changed(ws);
      toast('Starter plan ready. Add an API key in Settings to chat with the coach.');
    } else {
      ui.view = 'settings';
      toast('Add your Anthropic API key to use the coach.');
    }
    return;
  }
  ui.view = 'coach';
  const chat = db.chats[ws] || [];
  if (!chat.length && !hasPlan(ws)) sendToCoach(`Plan my week of ${D.weekLabel(ws)}.`);
  else render();
}

function scrollChat() {
  const el = document.querySelector('.chat');
  if (el) el.scrollTop = el.scrollHeight;
}

// ---------- views ----------

function header() {
  const ws = ui.weekStart;
  const showWeek = ui.view === 'week' || ui.view === 'coach';
  const calChip = !db.settings.googleClientId ? '' : Cal.isConnected()
    ? `<button class="chip ${ui.syncing || ui.calState === 'loading' ? 'pulse' : ''}" data-act="cal-refresh" title="Refresh calendar">${ic('calendar')} ${ui.syncing ? 'Syncing' : ui.calState === 'loading' ? 'Loading' : getWeek(ws).synced || !hasPlan(ws) ? 'Synced' : 'Sync'}</button>`
    : `<button class="chip warn" data-act="cal-connect">${ic('calendar')} Connect</button>`;
  return `
    <header class="top">
      <div class="brand"><span class="mark">${TRAIL_MARK}</span>Switchback</div>
      <div class="chips">
        ${calChip}
        <button class="chip" data-act="nav" data-view="coach" title="AI spend this week">${ic('sparkles')} ${Coach.cents(Coach.spentThisWeek())}</button>
      </div>
    </header>
    ${showWeek ? `
    <nav class="weeknav">
      <button class="icon" data-act="week" data-delta="-7" aria-label="Previous week">${ic('chevron-left')}</button>
      <div class="weeklabel">
        <small>${ws === D.mondayOf(D.todayIso()) ? 'This week' : ws > D.todayIso() ? 'Up next' : 'Past week'}</small>
        <b>${esc(D.weekLabel(ws))}</b>
      </div>
      <button class="icon" data-act="week" data-delta="7" aria-label="Next week">${ic('chevron-right')}</button>
    </nav>` : ''}`;
}

function hero(ws) {
  const week = getWeek(ws);
  const { total } = P.weekProgress(week);
  const planned = weekRunMiles(week);
  const ran = weekRunMiles(week, { doneOnly: true });
  const streak = P.summitStreak(ws);
  // Animate the day's marker once you're back on the week (not behind an open sheet).
  const pop = ui.popDate && D.mondayOf(ui.popDate) === ws && !ui.sheet ? ui.popDate : null;
  if (pop) ui.popDate = null;
  return `
    <section class="hero">
      <div class="hero-title">${total ? esc(P.trailMessage(week)) : 'New week, new trail'}</div>
      ${total ? '' : `<div class="hero-msg">${esc(P.trailMessage(week))}</div>`}
      ${P.trailSvg(week, { pop })}
      <div class="hero-chips">
        ${planned ? `<span class="mini-chip">${ic('run')} ${ran} of ${planned} mi</span>` : ''}
        ${lockedCount(ws).total && lockedCount(ws).locked === lockedCount(ws).total ? `<span class="mini-chip sun">${ic('lock')} Week locked in</span>` : ''}
        ${streak >= 2 ? `<span class="mini-chip sun">${ic('flag')} ${streak}-week streak</span>` : ''}
      </div>
      ${lockedCount(ws).total && lockedCount(ws).locked < lockedCount(ws).total
        ? `<button class="btn primary wide lock-week" data-act="lock-week">${ic('lock')} Lock in the week<small>${lockedCount(ws).locked} of ${lockedCount(ws).total} days locked in</small></button>`
        : ''}
    </section>`;
}

// Shown when you're looking ahead (Sunday planning) or on Monday: how last week went.
function recap(ws) {
  const today = D.todayIso();
  if (!(ws > today || (ws === D.mondayOf(today) && D.dow(today) === 1))) return '';
  const prevStart = D.addDays(ws, -7);
  const prev = db.weeks[prevStart];
  const t = P.weekTotals(prev);
  if (!t.workouts) return '';
  const hours = t.minutes >= 60 ? `${Math.round((t.minutes / 60) * 10) / 10}` : null;
  const stat = (value, label) => `<div><b>${value}</b><span>${label}</span></div>`;
  return `
    <section class="recap">
      <div class="recap-head">
        <b>Last week</b><span>${esc(D.weekLabel(prevStart))}</span>
        ${P.isSummit(prev) ? `<span class="badge sun">${ic('flag')} Summit</span>` : ''}
      </div>
      <div class="recap-stats">
        ${stat(t.workouts, 'workouts')}
        ${stat(t.miles, 'miles run')}
        ${t.elevation ? stat(t.elevation.toLocaleString(), 'ft climbed') : ''}
        ${stat(hours ?? t.minutes, hours ? 'hours active' : 'min active')}
      </div>
    </section>`;
}

function eventLine(e) {
  if (e.office) return '';
  const when = e.allDay ? 'All day' : `${D.prettyTime(e.start)}–${D.prettyTime(e.end)}`;
  return `<li class="${e.free ? 'free' : ''}"><time>${when}</time> ${esc(e.title)}</li>`;
}

// ---------- day review: calendar + workouts on one timeline ----------

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const span = (s, e) => `${D.prettyTime(fromMin(s))}–${D.prettyTime(fromMin(e))}`;

// A commitment is to a specific set of workouts at specific times; changing them un-commits the day.
function commitKey(list) {
  return list.filter((w) => w.status === 'planned' && w.type !== 'rest')
    .map((w) => `${w.id}@${workoutWindow(w).start}`).sort().join('|');
}

function isCommitted(date) {
  const week = getWeek(D.mondayOf(date));
  const key = commitKey(week.days[date] || []);
  return !!key && week.commits?.[date] === key;
}

// Days from today on that have planned workouts, and how many of those are locked in.
function lockedCount(ws) {
  const days = D.weekDates(ws).filter((d) => d >= D.todayIso()
    && (getWeek(ws).days[d] || []).some((w) => w.status === 'planned' && w.type !== 'rest'));
  return { total: days.length, locked: days.filter(isCommitted).length };
}

const LOCK_LINES = [
  'Future you says thanks.',
  'A promise to yourself. Nice.',
  'On the calendar, in the bag.',
  'One more switchback up the trail.',
  'That\'s how summits happen.',
];

// The "locked in" moment: confetti, a check that draws itself, and the day's plan.
function celebrateLockIn(date) {
  const ws = D.mondayOf(date);
  const items = (getWeek(ws).days[date] || []).filter((w) => w.status === 'planned' && w.type !== 'rest');
  const lines = items.map((w) => {
    const f = forecastFor(w, date);
    return `<li>${ic(TYPES[w.type].icon)} ${esc(w.title)} · ${D.prettyTime(workoutWindow(w).start)}${f ? ` · ${f.temp}°` : ''}</li>`;
  }).join('');
  const { locked, total } = lockedCount(ws);
  celebrate({
    title: `${D.DOW_LONG[D.dow(date)]} is locked in!`,
    lines,
    sub: pick(LOCK_LINES),
    badge: `${locked} of ${total} ${total === 1 ? 'day' : 'days'} locked in this week`,
  });
}

// The selected day as a small calendar: hours down the side, busy time in gray,
// workouts as blocks you can press, hold and drag to a new time.
const PX_PER_MIN = 0.7;

function dayTimeline(date) {
  const ws = D.mondayOf(date);
  const cal = calendarFor(ws);
  const events = (cal?.[date] || []).filter((e) => !e.office);
  const busy = events.filter((e) => !e.allDay).map((e) => ({ s: toMin(e.start), e: toMin(e.end), title: e.title }));
  const wks = (getWeek(ws).days[date] || []).filter((w) => w.type !== 'rest' && w.status !== 'skipped')
    .map((w) => { const t = workoutWindow(w); return { w, s: toMin(t.start), e: toMin(t.end) }; });

  // Show 6am–10pm, widened to fit anything earlier or later.
  const start = Math.min(6 * 60, ...[...busy, ...wks].map((x) => Math.floor(x.s / 60) * 60));
  const end = Math.max(22 * 60, ...[...busy, ...wks].map((x) => Math.ceil(x.e / 60) * 60));
  const y = (m) => ((m - start) * PX_PER_MIN).toFixed(1);
  const clashWith = (x) => busy.find((b) => x.s < b.e && b.s < x.e);

  const hours = [];
  for (let h = start / 60; h <= end / 60; h++) {
    hours.push(`<div class="hr" style="top:${y(h * 60)}px"><span>${h % 12 || 12}${h < 12 || h === 24 ? 'a' : 'p'}</span></div>`);
  }
  const busyBlocks = busy.map((b) => `
    <div class="blk busy" style="top:${y(b.s)}px;height:${Math.max((b.e - b.s) * PX_PER_MIN, 16)}px">
      <span>${esc(b.title)} · ${span(b.s, b.e)}</span>
    </div>`).join('');
  const wkBlocks = wks.map((x) => {
    const t = TYPES[x.w.type];
    const f = forecastFor(x.w, date);
    const draggable = x.w.status === 'planned' && date >= D.todayIso();
    return `
      <button class="blk tl-wk ${clashWith(x) ? 'clash' : ''} ${x.w.status === 'done' ? 'done' : ''} ${draggable ? 'movable' : ''}"
        style="--c:${t.color};top:${y(x.s)}px;height:${Math.max((x.e - x.s) * PX_PER_MIN, 40)}px"
        data-act="open" data-date="${date}" data-id="${x.w.id}" data-start="${x.s}" data-len="${x.e - x.s}">
        <b>${ic(t.icon)} ${esc(x.w.title)}</b>
        <time>${span(x.s, x.e)}</time>
        ${f ? `<span class="wx">${ic(W.icon(f.code))} ${f.temp}°${f.rain >= 20 ? `<small>${f.rain}%</small>` : ''}</span>` : ''}
      </button>`;
  }).join('');

  const clashes = wks.filter((x) => x.w.status === 'planned' && clashWith(x));
  const allDay = events.filter((e) => e.allDay);
  const planned = wks.some((x) => x.w.status === 'planned');
  const committed = isCommitted(date);
  return `
    <div class="timeline">
      ${!db.settings.googleClientId ? '<p class="hint">Add Google Calendar in Settings to see your busy times here.</p>' : ''}
      ${allDay.map((e) => `<div class="allday">${esc(e.title)}</div>`).join('')}
      <div class="grid" style="height:${y(end)}px" data-start="${start}" data-end="${end}" data-ppm="${PX_PER_MIN}">${hours.join('')}${busyBlocks}${wkBlocks}</div>
      ${clashes.map((x) => `<div class="warn-line">${ic('alert-triangle')} ${esc(x.w.title)} overlaps busy time ${span(clashWith(x).s, clashWith(x).e)}</div>`).join('')}
      ${planned && date >= D.todayIso() ? '<p class="hint">Press and hold a workout to drag it to a new time, or tap it to edit.</p>' : ''}
      ${date >= D.todayIso() && planned ? `
        <div class="row commit">
          ${committed
            ? `<span class="committed">${ic('lock')} Locked in. Future you says thanks.</span>`
            : `<button class="btn primary" data-act="commit" data-date="${date}">${ic('check')} I'm in</button>
               <button class="btn" data-act="needs-changes" data-date="${date}">Needs changes</button>`}
        </div>` : ''}
    </div>`;
}

// Forecast at the hour an outdoor workout starts, if it's still coming up.
function forecastFor(w, date) {
  if (!W.OUTDOOR.has(w.type) || w.status !== 'planned') return null;
  return W.at(date, workoutWindow(w).start);
}

function workoutButton(w, date) {
  const t = TYPES[w.type] || TYPES.walk;
  const meta = summary(w);
  const f = forecastFor(w, date);
  return `
    <button class="wk s-${w.status}" style="--c:${t.color}" data-act="open" data-date="${date}" data-id="${w.id}">
      <span class="wk-icon">${ic(t.icon)}</span>
      <span class="wk-main"><b>${esc(w.title || t.label)}${w.pinned && w.status === 'planned' ? `<span class="pin" title="You placed this; the coach won't move it">${ic('pin')}</span>` : ''}</b>${meta ? `<small>${esc(meta)}</small>` : ''}</span>
      ${f ? `<span class="wx">${ic(W.icon(f.code))} ${f.temp}°${f.rain >= 20 ? `<small>${f.rain}%</small>` : ''}</span>` : ''}
      <span class="wk-check">${w.status === 'done' ? (w.feel ? FEELS[w.feel - 1] : ic('check')) : w.status === 'skipped' ? '–' : ''}</span>
    </button>`;
}

function weekView() {
  const ws = ui.weekStart;
  const week = getWeek(ws);
  const cal = calendarFor(ws);
  const today = D.todayIso();
  const warnings = currentWarnings(ws);
  const planned = hasPlan(ws);
  const isSunday = D.dow(today) === 0;

  const cta = !planned
    ? `<button class="cta" data-act="plan">${ic('sparkles')} ${isSunday && ws > today ? 'Plan next week' : 'Plan this week'}</button>`
    : week.manualChange
      ? `<div class="banner"><span>You changed the plan.<small>The coach will check it and suggest tweaks for you to approve.</small></span><button class="cta small" data-act="rebalance">${ic('sparkles')} Review my changes</button></div>`
      : '';

  const general = warnings.filter((w) => !w.date);
  const days = D.weekDates(ws).map((date) => {
    const list = week.days[date] || [];
    const events = (cal?.[date] || []).map(eventLine).filter(Boolean);
    const dayWarn = warnings.filter((w) => w.date === date);
    const selected = ui.selected === date;
    const office = isOfficeDay(date, db.settings, cal);
    return `
      <section class="day ${date === today ? 'today' : ''} ${date < today ? 'past' : ''} ${selected ? 'selected' : ''}" data-date="${date}" data-act="select-day">
        <div class="day-head">
          <div class="dname">${D.DOW[D.dow(date)]}</div>
          <div class="dnum">${D.parse(date).getDate()}</div>
          ${date === today ? '<span class="badge hot">Today</span>' : ''}
          ${!selected && isCommitted(date) ? `<span class="badge in">${ic('lock')} Locked in</span>` : ''}
          ${office ? `<button class="badge office" data-act="toggle-office" data-date="${date}" title="Tap if you're not in the office this day">${ic('building')} Office ${ic('x')}</button>` : ''}
          ${date < today
            ? `<button class="add log" data-act="add" data-date="${date}">${ic('plus')} Log</button>`
            : `<button class="add" data-act="add" data-date="${date}" aria-label="Add to ${D.DOW[D.dow(date)]}">${ic('plus')}</button>`}
        </div>
        ${selected ? dayTimeline(date) : `
          ${events.length ? `<ul class="events">${events.slice(0, 3).join('')}${events.length > 3 ? `<li><button class="more" data-act="select-day" data-date="${date}">+${events.length - 3} more</button></li>` : ''}</ul>` : ''}
          <div class="wks">${list.map((w) => workoutButton(w, date)).join('') || `<div class="empty">${office ? 'Office day — no workouts' : date < today ? 'Nothing logged' : 'Nothing planned'}</div>`}</div>`}
        ${dayWarn.map((w) => `<div class="warn-line">${ic('alert-triangle')} ${esc(w.text)}</div>`).join('')}
      </section>`;
  }).join('');

  return `
    ${recap(ws)}
    ${hero(ws)}
    ${cta}
    ${db.settings.profile.trim() ? '' : `<button class="ghost setup" data-act="nav" data-view="settings">${ic('user')} Tell your coach about your routine</button>`}
    ${general.map((w) => `<div class="warn-line block">${ic('alert-triangle')} ${esc(w.text)}</div>`).join('')}
    <div class="days">${days}</div>
    ${planned && !db.settings.dragHintSeen ? '<p class="hint center">Tip: press and hold a workout to drag it to another day.</p>' : ''}
    ${planned ? `<button class="ghost" data-act="nav" data-view="coach">${ic('message-circle')} Talk to your coach</button>` : ''}`;
}

function coachView() {
  const ws = ui.weekStart;
  const chat = db.chats[ws] || [];
  const hasKey = !!db.settings.anthropicKey.trim();
  const chips = !hasPlan(ws)
    ? ['Plan my week']
    : ["I'm sore today", 'Something came up', 'Swap two days', 'Rebalance the rest of the week'];

  const bubbles = chat.map((m, i) => `
    <div class="msg ${m.role}">
      <p>${esc(m.text)}</p>
      ${m.proposal ? proposalCard(m, i) : ''}
      ${m.role === 'assistant' ? `
        <div class="msg-meta">
          ${m.planChanged ? '<button class="link" data-act="nav" data-view="week">Plan updated ✓ View week →</button>' : ''}
          ${m.logged ? `<span>Logged ${m.logged} activit${m.logged > 1 ? 'ies' : 'y'} ✓</span>` : ''}
          <span class="cost">${Coach.cents(m.cost || 0)}</span>
        </div>` : ''}
    </div>`).join('');

  return `
    <div class="chat">
      ${!chat.length && !ui.pending ? `
        <div class="coach-intro">
          <h2>Your coach</h2>
          <p>Tell me what your week looks like, how you're feeling, or what you already did. I'll build the plan and keep it balanced as things change.</p>
          ${hasKey ? '' : '<p class="muted">Add your Anthropic API key in <button class="link" data-act="nav" data-view="settings">Settings</button> to turn me on.</p>'}
        </div>` : ''}
      ${bubbles}
      ${ui.pending ? `<div class="msg user"><p>${esc(ui.pending)}</p></div><div class="msg assistant ${ui.liveReply ? '' : 'typing'}" id="live">${liveReplyHtml()}</div>` : ''}
      ${ui.chatError ? `<div class="warn-line block">${ic('alert-triangle')} ${esc(ui.chatError)}</div>` : ''}
    </div>
    <div class="composer">
      <div class="quick">${chips.map((c) => `<button class="chip" data-act="quick" data-text="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <form data-form="chat">
        <textarea name="text" rows="1" placeholder="Tell your coach anything…" data-draft>${esc(ui.draft)}</textarea>
        <button class="send" ${ui.busy ? 'disabled' : ''} aria-label="Send">${ic('send-2')}</button>
      </form>
      <div class="budget">AI this week: ${Coach.cents(Coach.spentThisWeek())} of ${Coach.cents(db.settings.weeklyBudget)} cap</div>
    </div>`;
}

function settingsView() {
  const s = db.settings;
  const connected = Cal.isConnected();
  return `
    <div class="settings">
      <h2>Settings</h2>

      <section class="card">
        <h3>${ic('sparkles')} AI coach</h3>
        <label>Anthropic API key
          <input type="password" autocomplete="off" data-setting="anthropicKey" value="${esc(s.anthropicKey)}" placeholder="sk-ant-…">
        </label>
        <p class="hint">Stored only on this phone. Uses Claude Haiku 5.5 — usually well under 1¢ per message.</p>
        <label>Weekly spending cap (USD)
          <input type="number" step="0.05" min="0" data-setting="weeklyBudget" value="${s.weeklyBudget}">
        </label>
        <p class="hint">Spent this week: ${Coach.cents(Coach.spentThisWeek())}. When the cap is hit, the coach pauses until Monday.</p>
      </section>

      <section class="card">
        <h3>${ic('calendar')} Google Calendar</h3>
        <p class="hint">Switchback only sees when you're busy, never what your events are.</p>
        <label>OAuth client ID
          <input type="text" autocomplete="off" data-setting="googleClientId" value="${esc(s.googleClientId)}" placeholder="….apps.googleusercontent.com">
        </label>
        <div class="row">
          ${connected
            ? '<button class="btn" data-act="cal-disconnect">Disconnect</button><button class="btn" data-act="sunday">Add Sunday reminder</button><button class="btn" data-act="checkin-reminder">Add 8pm check-in reminder</button>'
            : `<button class="btn primary" data-act="cal-connect" ${s.googleClientId ? '' : 'disabled'}>Connect Google Calendar</button>`}
        </div>
        ${s.sundayReminderId ? '<p class="hint">✓ Sunday 6pm “Plan your week” reminder is on your Workouts calendar.</p>' : ''}
        ${s.checkinReminderId ? '<p class="hint">✓ Daily 8pm “one thing” check-in reminder is on your Workouts calendar.</p>' : ''}
        <label>Remind me before workouts (minutes)
          <input type="number" min="0" step="5" data-setting="reminderMinutes" value="${s.reminderMinutes}">
        </label>
        <label class="check"><input type="checkbox" data-setting="nightBeforeNudge" ${s.nightBeforeNudge ? 'checked' : ''}> 9pm heads-up the night before morning workouts</label>
      </section>

      <section class="card">
        <h3>${ic('user')} About me</h3>
        <p class="hint">Office days (no workouts):</p>
        <div class="daypick">${[1, 2, 3, 4, 5, 6, 0].map((d) => `
          <button class="chip ${s.officeDays.includes(d) ? 'on' : ''}" data-act="office" data-dow="${d}">${D.DOW[d]}</button>`).join('')}
        </div>
        <label>What the coach should know about you
          <textarea rows="8" data-setting="profile" placeholder="Your usual week, goals and limits. For example:
- Soccer on Thursday nights
- Run 2–3x a week, usually 3 mi
- Evenings work best for me
- Goal: add yoga once a week">${esc(s.profile)}</textarea>
        </label>
      </section>

      <section class="card">
        <h3>${ic('sun')} Weather</h3>
        <p class="hint">Shows the forecast at the hour of your outdoor workouts. Uses the place you type here, never your phone's location.</p>
        ${s.weatherPlace
          ? `<div class="row place">${ic('map-pin')} <b>${esc(s.weatherPlace.name)}</b><button class="link" data-act="weather-clear">Change</button></div>`
          : `<form data-form="weather" class="row place-form"><input name="place" placeholder="City or ZIP code" autocomplete="off"><button class="btn primary">Set</button></form>`}
      </section>

      <section class="card">
        <h3>${ic('database')} Your data</h3>
        <p class="hint">Everything lives on this phone. Back it up now and then.</p>
        <div class="row">
          <button class="btn" data-act="export">Export backup</button>
          <label class="btn">Import backup<input type="file" accept="application/json" data-act-change="import" hidden></label>
        </div>
        <div class="row"><button class="btn danger" data-act="clear-week">Clear plan for ${esc(D.weekLabel(ui.weekStart))}</button></div>
      </section>
      <p class="hint center">Switchback v1</p>
    </div>`;
}

function workoutForm(w, date, isNew) {
  const t = w.type;
  const timeOpts = ['anytime', 'morning', 'midday', 'evening'];
  return `
    <form data-form="${isNew ? 'add' : 'edit'}" class="wform">
      <div class="types">${TYPE_KEYS.map((k) => `
        <label class="type-pill" style="--c:${TYPES[k].color}"><input type="radio" name="type" value="${k}" ${k === t ? 'checked' : ''}><span>${ic(TYPES[k].icon)} ${TYPES[k].label}</span></label>`).join('')}
      </div>
      <label>Title<input name="title" value="${esc(w.title)}" placeholder="e.g. Easy run"></label>
      <div class="grid3">
        <label>Miles<input name="distanceMi" type="number" step="0.1" min="0" inputmode="decimal" value="${w.distanceMi ?? ''}"></label>
        <label>Minutes<input name="minutes" type="number" step="5" min="0" inputmode="numeric" value="${w.minutes ?? ''}"></label>
        <label>Elev ft<input name="elevationFt" type="number" step="100" min="0" inputmode="numeric" value="${w.elevationFt ?? ''}"></label>
      </div>
      <div class="grid3">
        <label>When<select name="timeOfDay">${timeOpts.map((o) => `<option ${o === w.timeOfDay ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
        <label>Start<input name="startTime" type="time" value="${w.startTime || ''}"></label>
        <label>Effort<select name="intensity">${['easy', 'moderate', 'hard'].map((o) => `<option ${o === w.intensity ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
      </div>
      <label>Details<textarea name="detail" rows="2">${esc(w.detail)}</textarea></label>
      ${isNew ? `<label class="check"><input type="checkbox" name="done" ${date <= D.todayIso() ? 'checked' : ''}> I already did this</label>` : ''}
      <button class="btn primary wide">${isNew ? 'Add' : 'Save changes'}</button>
    </form>`;
}

function sheet() {
  const s = ui.sheet;
  if (!s) return '';
  const dayName = `${D.DOW_LONG[D.dow(s.date)]}, ${D.shortDate(s.date)}`;
  let body;
  if (s.kind === 'add') {
    body = `<div class="sheet-kicker">${s.date < D.todayIso() ? 'Log' : 'Add'} · ${esc(dayName)}</div>${workoutForm(workout({ type: s.type || 'run', title: '' }), s.date, true)}
      <button class="btn wide" data-act="toggle-office" data-date="${s.date}">${ic('building')} ${isOfficeDay(s.date, db.settings, calendarFor(D.mondayOf(s.date))) ? 'Not an office day' : 'Mark as office day'}</button>`;
  } else {
    const w = findWorkout(s.date, s.id);
    if (!w) { ui.sheet = null; return ''; }
    const t = TYPES[w.type];
    const ws = D.mondayOf(s.date);
    body = `
      <div class="sheet-kicker" style="--c:${t.color}">${ic(t.icon)} ${t.label} · ${esc(dayName)}</div>
      <h2>${esc(w.title || t.label)}</h2>
      ${w.detail ? `<p class="detail">${esc(w.detail)}</p>` : ''}
      ${summary(w) ? `<p class="meta">${esc(summary(w))} · ${esc(w.intensity)}</p>` : ''}
      <div class="row status">
        <button class="btn ${w.status === 'done' ? 'primary' : ''}" data-act="status" data-status="done">${ic('check')} Done</button>
        <button class="btn ${w.status === 'skipped' ? 'primary' : ''}" data-act="status" data-status="skipped">${ic('player-skip-forward')} Skip</button>
        ${w.status !== 'planned' ? `<button class="btn" data-act="status" data-status="planned">${ic('arrow-back-up')} Undo</button>` : ''}
      </div>
      ${w.status === 'done' ? `
        <p class="hint">How did it feel?</p>
        <div class="feels">${FEELS.map((f, i) => `<button class="feel ${w.feel === i + 1 ? 'on' : ''}" data-act="feel" data-feel="${i + 1}">${f}</button>`).join('')}</div>
        <label>Note<input data-wfield="note" value="${esc(w.note)}" placeholder="e.g. calves tight"></label>` : ''}
      <p class="hint">Move to</p>
      <div class="daypick">${D.weekDates(ws).map((d) => `
        <button class="chip ${d === s.date ? 'on' : ''}" data-act="move" data-to="${d}">${D.DOW[D.dow(d)]}</button>`).join('')}
      </div>
      <details ${s.editing ? 'open' : ''}><summary>Edit details</summary>${workoutForm(w, s.date, false)}</details>
      ${w.pinned && w.status === 'planned' ? `<p class="hint pin-note">${ic('pin')} Pinned: the coach won't move or change this. <button class="link" data-act="unpin">Let the coach adjust it</button></p>` : ''}
      <button class="btn danger wide" data-act="delete">Delete</button>`;
  }
  return `<div class="backdrop" data-act="close"></div><div class="sheet" role="dialog">${body}</div>`;
}

function nav() {
  const item = (view, icon, label) => `<button class="${ui.view === view ? 'on' : ''}" data-act="nav" data-view="${view}"><span>${ic(icon)}</span>${label}</button>`;
  return `<nav class="tabs">${item('week', 'calendar-week', 'Week')}${item('today', 'sun', 'Today')}${item('coach', 'message-circle', 'Coach')}${item('settings', 'settings', 'Settings')}</nav>`;
}

function render({ background = false } = {}) {
  // Background updates (calendar loading, syncing) must not wipe a form you are typing in.
  const editing = ui.sheet || document.activeElement?.matches?.('input, textarea, select');
  if (background && editing && document.getElementById('hdr')) {
    document.getElementById('hdr').innerHTML = header();
    return;
  }
  const active = document.activeElement;
  const keepFocus = active?.matches?.('[data-setting], [data-draft], [data-wfield]')
    ? { sel: active.dataset.setting ? `[data-setting="${active.dataset.setting}"]` : active.dataset.wfield ? `[data-wfield="${active.dataset.wfield}"]` : '[data-draft]', pos: active.selectionStart }
    : null;
  const sheetScroll = document.querySelector('.sheet')?.scrollTop;

  const view = ui.view === 'coach' ? coachView() : ui.view === 'settings' ? settingsView() : ui.view === 'today' ? T.todayView(ui) : weekView();
  $app.innerHTML = `
    <div id="hdr">${header()}</div>
    <main class="view-${ui.view}">${view}</main>
    ${nav()}
    ${sheet()}
    ${ui.toast ? `<div class="toast">${esc(ui.toast)}</div>` : ''}`;

  if (keepFocus) {
    const el = document.querySelector(keepFocus.sel);
    if (el) { el.focus(); try { el.setSelectionRange(keepFocus.pos, keepFocus.pos); } catch {} }
  }
  if (sheetScroll) document.querySelector('.sheet').scrollTop = sheetScroll;
}

// ---------- events ----------

function readForm(form) {
  const f = new FormData(form);
  const num = (k) => (f.get(k) === '' || f.get(k) == null ? null : Number(f.get(k)));
  const type = f.get('type') || 'walk';
  return {
    type,
    title: (f.get('title') || '').trim() || TYPES[type].label,
    distanceMi: num('distanceMi'),
    minutes: num('minutes'),
    elevationFt: num('elevationFt'),
    timeOfDay: f.get('timeOfDay'),
    startTime: f.get('startTime') || null,
    intensity: f.get('intensity'),
    detail: (f.get('detail') || '').trim(),
    done: f.get('done') === 'on',
  };
}

// Office day or not, for this one date only (the weekly setting stays as is).
function setOfficeDay(date, office) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const week = getWeek(D.mondayOf(date));
  week.officeOverrides = { ...week.officeOverrides, [date]: office };
  save();
}

async function setWeatherPlace(query) {
  if (!query.trim()) return;
  try {
    db.settings.weatherPlace = await W.findPlace(query);
    save();
    await W.refresh({ force: true });
    toast(`Weather set to ${db.settings.weatherPlace.name}`);
  } catch (e) {
    toast(e.message);
  }
}

function moveWorkout(date, id, to) {
  const ws = D.mondayOf(date);
  const from = dayWorkouts(ws, date);
  const w = from.splice(from.findIndex((x) => x.id === id), 1)[0];
  w.pinned = true;
  dayWorkouts(D.mondayOf(to), to).push(w);
  changed(ws, w.status === 'planned' ? `Moved ${w.title} from ${D.DOW[D.dow(date)]} to ${D.DOW[D.dow(to)]}.` : '');
}


// ---------- daily check-in ----------

const COMMIT_LINES = ['A promise to yourself.', 'Future you says thanks.', 'Small things, every day.', 'That\'s the spirit.'];
const DONE_LINES = ['You showed up for yourself.', 'That counts. Every bit of it.', 'Nice. Keep the streak going.', 'One more good day on the trail.'];

const ciDate = () => ui.checkinDate || D.todayIso();

function resetPicker() {
  ui.ciSel = new Set();
  ui.ciCustom = false;
  ui.ciAdding = false;
  ui.ciEdit = false;
}

// Commit to everything you've selected in the picker.
function commitSelected() {
  const date = ciDate();
  const chosen = [...(ui.ciSel || [])].map((key) => {
    const [kind, id] = [key.slice(0, 1), key.slice(2)];
    if (kind === 'w') {
      const w = T.workoutsOn(date).find((x) => x.id === id);
      return w && { label: w.title, icon: TYPES[w.type].icon, category: 'move', workoutId: w.id };
    }
    const o = T.allOptions().find((x) => x.id === id);
    return o && { label: o.label, icon: o.icon, category: o.category };
  }).filter(Boolean);
  if (!chosen.length) return;
  const first = !T.dayCheckin(date).items.length;
  T.addItems(date, chosen);
  resetPicker();
  render();
  if (first) {
    celebrate({
      title: date === D.todayIso() ? 'You\'re committed!' : 'Committed',
      lines: chosen.map((c) => `<li>${ic(c.icon)} ${esc(c.label)}</li>`).join(''),
      sub: pick(COMMIT_LINES),
    });
  } else {
    toast(`Added ${chosen.length === 1 ? esc(chosen[0].label) : `${chosen.length} things`}`);
  }
}

function finishItem(id) {
  const date = ciDate();
  const it = T.itemFor(date, id);
  if (!it) return;
  const firstDone = !T.isDone(date);
  // Committing to a workout and doing it marks the workout done too.
  const w = it.workoutId && findWorkout(date, it.workoutId);
  if (w && w.status !== 'done') {
    w.status = 'done';
    changed(D.mondayOf(date));
  }
  T.setItem(date, id, { status: 'done', doneAt: Date.now() });
  render();
  const n = T.streak();
  if (firstDone) {
    celebrate({
      title: 'You did it!',
      lines: `<li>${ic(it.icon)} ${esc(it.label)}</li>`,
      sub: pick(DONE_LINES),
      badge: n ? `${T.streakText(n)} showing up for yourself` : '',
      badgeIcon: 'flame',
    });
  } else {
    const count = T.dayCheckin(date).items.filter((x) => x.status === 'done').length;
    toast(`Nice. ${count} things for you today.`);
  }
}

const actions = {
  'prop-flag': (el) => {
    const p = db.chats[ui.weekStart][Number(el.dataset.msg)].proposal;
    p.useFlag[Number(el.dataset.i)] = el.dataset.use === '1';
    save();
    render();
  },
  'prop-apply': (el) => {
    const p = db.chats[ui.weekStart][Number(el.dataset.msg)].proposal;
    p.appliedCount = applyProposal(p);
    p.status = 'applied';
    save();
    toast('Plan updated');
  },
  'prop-dismiss': (el) => {
    const p = db.chats[ui.weekStart][Number(el.dataset.msg)].proposal;
    p.status = 'dismissed';
    getWeek(p.ws).manualChange = '';
    save();
    render();
  },
  'lock-week': () => {
    const ws = ui.weekStart;
    const week = getWeek(ws);
    const days = D.weekDates(ws).filter((d) => d >= D.todayIso()
      && (week.days[d] || []).some((w) => w.status === 'planned' && w.type !== 'rest'));
    week.commits = { ...week.commits };
    for (const d of days) week.commits[d] = commitKey(week.days[d]);
    save();
    render();
    celebrate({
      title: 'Your week is locked in!',
      lines: days.map((d) => {
        const list = week.days[d].filter((w) => w.status === 'planned' && w.type !== 'rest' && w.type !== 'stretch');
        const first = list[0] || week.days[d].find((w) => w.status === 'planned');
        return `<li><b>${D.DOW[D.dow(d)]}</b> ${ic(TYPES[first.type].icon)} ${esc(first.title)}${list.length > 1 ? ` +${list.length - 1}` : ''}</li>`;
      }).join(''),
      sub: pick(LOCK_LINES),
      badge: `${days.length} ${days.length === 1 ? 'day' : 'days'} locked in`,
    });
  },
  unpin: () => {
    const w = findWorkout(ui.sheet.date, ui.sheet.id);
    w.pinned = false;
    save();
    toast('The coach can adjust this one now');
  },
  'ci-pick': (el) => {
    ui.ciSel = ui.ciSel || new Set();
    const { key } = el.dataset;
    ui.ciSel.has(key) ? ui.ciSel.delete(key) : ui.ciSel.add(key);
    render();
  },
  'ci-custom': () => { ui.ciCustom = !ui.ciCustom; render(); },
  'ci-commit': commitSelected,
  'ci-add': () => { resetPicker(); ui.ciAdding = true; render(); },
  'ci-edit': () => { ui.ciEdit = !ui.ciEdit; render(); },
  'ci-opt-up': (el) => { T.moveOption(el.dataset.id, -1); render(); },
  'ci-opt-down': (el) => { T.moveOption(el.dataset.id, 1); render(); },
  'ci-opt-remove': (el) => { T.removeOption(el.dataset.id); render(); },
  'ci-opt-restore': () => { T.restoreHidden(); render(); },
  'ci-done': (el) => finishItem(el.dataset.id),
  'ci-skip': (el) => { T.setItem(ciDate(), el.dataset.id, { status: 'skipped' }); render(); },
  'ci-undo': (el) => {
    const it = T.itemFor(ciDate(), el.dataset.id);
    const w = it?.workoutId && findWorkout(ciDate(), it.workoutId);
    if (w && w.status === 'done') { w.status = 'planned'; changed(D.mondayOf(ciDate())); }
    T.setItem(ciDate(), el.dataset.id, { status: 'committed' });
    render();
  },
  'ci-remove': (el) => { T.removeItem(ciDate(), el.dataset.id); render(); },
  'ci-mood': (el) => { T.setDay(ciDate(), { mood: Number(el.dataset.mood) }); render(); },
  'ci-date': (el) => {
    ui.checkinDate = el.dataset.date && el.dataset.date !== D.todayIso() ? el.dataset.date : null;
    resetPicker();
    render();
    scrollTo(0, 0);
  },
  'ci-month': (el) => {
    const [y, m] = (ui.ciMonth || D.todayIso().slice(0, 7)).split('-').map(Number);
    const d = new Date(y, m - 1 + Number(el.dataset.delta), 1);
    ui.ciMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    render();
  },
  nav: (el) => { ui.view = el.dataset.view; ui.sheet = null; render(); if (ui.view === 'coach') scrollChat(); },
  week: (el) => {
    ui.weekStart = D.addDays(ui.weekStart, Number(el.dataset.delta));
    ui.chatError = '';
    render();
    if (!calendarFor(ui.weekStart)) refreshCalendar(ui.weekStart);
  },
  plan: startPlanning,
  rebalance: () => sendToCoach(`Please review the changes I made: ${getWeek(ui.weekStart).manualChange}`, { mode: 'review' }),
  quick: (el) => {
    const text = el.dataset.text;
    if (text === 'Plan my week') return sendToCoach(`Plan my week of ${D.weekLabel(ui.weekStart)}.`);
    if (text === 'Rebalance the rest of the week') return sendToCoach('Rebalance the rest of the week based on what I have done so far and how I feel.');
    ui.draft = `${text}: `;
    render();
    const ta = document.querySelector('[data-draft]');
    ta?.focus();
    ta?.setSelectionRange(ui.draft.length, ui.draft.length);
  },
  open: (el) => { ui.sheet = { kind: 'workout', date: el.dataset.date, id: el.dataset.id }; render(); },
  add: (el) => { ui.sheet = { kind: 'add', date: el.dataset.date }; render(); },
  close: () => { ui.sheet = null; render(); },
  status: (el) => {
    const w = findWorkout(ui.sheet.date, ui.sheet.id);
    w.status = el.dataset.status;
    if (w.status !== 'done') w.feel = null;
    changed(D.mondayOf(ui.sheet.date));
    if (w.status === 'done') {
      const ws = D.mondayOf(ui.sheet.date);
      ui.popDate = ui.sheet.date;
      toast(P.doneCheer(getWeek(ws), ui.sheet.date));
    } else {
      render();
    }
  },
  feel: (el) => {
    const w = findWorkout(ui.sheet.date, ui.sheet.id);
    w.feel = Number(el.dataset.feel);
    save();
    render();
  },
  move: (el) => {
    const { date, id } = ui.sheet;
    const to = el.dataset.to;
    if (to === date) return;
    moveWorkout(date, id, to);
    ui.sheet = { ...ui.sheet, date: to };
    toast(`Moved to ${D.DOW_LONG[D.dow(to)]}`);
  },
  delete: () => {
    const { date, id } = ui.sheet;
    const ws = D.mondayOf(date);
    const list = dayWorkouts(ws, date);
    const w = list.splice(list.findIndex((x) => x.id === id), 1)[0];
    ui.sheet = null;
    changed(ws, w.status === 'planned' ? `Removed ${w.title} on ${D.DOW[D.dow(date)]}.` : '');
    render();
  },
  'cal-connect': connectCalendar,
  'cal-refresh': async () => {
    await refreshCalendar(ui.weekStart, { quiet: false });
    if (hasPlan(ui.weekStart) && !getWeek(ui.weekStart).synced) syncNow(ui.weekStart);
  },
  'cal-disconnect': () => { Cal.disconnect(); toast('Disconnected from Google Calendar.'); },
  'checkin-reminder': async () => {
    try {
      await Cal.ensureCheckinReminder(location.origin + location.pathname);
      toast('Daily check-in reminder added');
      render();
    } catch (e) {
      toast(e.message);
    }
  },
  sunday: async () => {
    try {
      await Cal.ensureSundayReminder(location.origin + location.pathname);
      toast('Sunday reminder added ✓');
    } catch (e) {
      toast(e.message);
    }
  },
  'weather-clear': () => {
    db.settings.weatherPlace = null;
    db.weather = null;
    save();
    render();
  },
  'select-day': (el) => {
    const date = el.dataset.date || el.closest('.day')?.dataset.date;
    ui.selected = ui.selected === date && el.matches('.day') ? null : date;
    render();
  },
  commit: (el) => {
    const { date } = el.dataset;
    const week = getWeek(D.mondayOf(date));
    week.commits = { ...week.commits, [date]: commitKey(week.days[date] || []) };
    save();
    ui.selected = null;
    render();
    celebrateLockIn(date);
  },
  'needs-changes': (el) => {
    const { date } = el.dataset;
    ui.selected = null;
    ui.view = 'coach';
    ui.draft = `${D.DOW_LONG[D.dow(date)]} doesn't work as planned: `;
    render();
    const ta = document.querySelector('[data-draft]');
    ta?.focus();
    ta?.setSelectionRange(ui.draft.length, ui.draft.length);
  },
  'toggle-office': (el) => {
    const { date } = el.dataset;
    const office = !isOfficeDay(date, db.settings, calendarFor(D.mondayOf(date)));
    setOfficeDay(date, office);
    ui.sheet = null;
    changed(D.mondayOf(date), `${D.DOW_LONG[D.dow(date)]} is ${office ? 'now an office day' : 'no longer an office day'} this week.`);
    toast(office ? `${D.DOW_LONG[D.dow(date)]} marked as an office day` : `${D.DOW_LONG[D.dow(date)]} isn't an office day this week`);
  },
  office: (el) => {
    const d = Number(el.dataset.dow);
    const set = new Set(db.settings.officeDays);
    set.has(d) ? set.delete(d) : set.add(d);
    db.settings.officeDays = [...set];
    save();
    render();
  },
  export: () => {
    const blob = new Blob([exportData()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `switchback-backup-${D.todayIso()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  'clear-week': () => {
    if (!confirm(`Clear the plan for ${D.weekLabel(ui.weekStart)}? Logged workouts are kept.`)) return;
    const week = getWeek(ui.weekStart);
    for (const d of Object.keys(week.days)) week.days[d] = week.days[d].filter((w) => w.status !== 'planned');
    week.manualChange = '';
    changed(ui.weekStart);
    toast('Plan cleared.');
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  e.preventDefault();
  actions[el.dataset.act]?.(el);
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  if (form.dataset.form === 'chat') return sendToCoach(form.text.value);
  if (form.dataset.form === 'weather') return setWeatherPlace(form.place.value);
  if (form.dataset.form === 'ci-custom') {
    const label = form.label.value.trim();
    if (!label) return toast('Give it a name first.');
    const option = T.addOption(label, new FormData(form).get('category') || 'create');
    ui.ciCustom = false;
    ui.ciSel = new Set([...(ui.ciSel || []), `o:${option.id}`]);
    render();
    return toast(`${label} added to your options`);
  }
  const data = readForm(form);
  const { date } = ui.sheet;
  const ws = D.mondayOf(date);
  if (form.dataset.form === 'add') {
    const { done, ...fields } = data;
    dayWorkouts(ws, date).push(workout({ ...fields, pinned: true, status: done ? 'done' : 'planned', source: done ? 'logged' : 'plan' }));
    ui.sheet = null;
    changed(ws, done ? '' : `Added ${fields.title} on ${D.DOW[D.dow(date)]}.`);
    if (done) ui.popDate = date;
    toast(done ? P.doneCheer(getWeek(ws), date) : 'Added to plan');
  } else {
    const w = findWorkout(date, ui.sheet.id);
    const { done, ...fields } = data;
    Object.assign(w, fields, { pinned: true });
    ui.sheet = { ...ui.sheet, editing: false };
    changed(ws, w.status === 'planned' ? `Edited ${w.title} on ${D.DOW[D.dow(date)]}.` : '');
    toast('Saved');
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.draft !== undefined) {
    ui.draft = el.value;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }
  if (el.dataset.ciNote !== undefined) {
    T.setDay(ciDate(), { note: el.value });
  }
  if (el.dataset.wfield) {
    const w = findWorkout(ui.sheet.date, ui.sheet.id);
    w[el.dataset.wfield] = el.value;
    save();
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  const key = el.dataset.setting;
  if (key) {
    db.settings[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) || 0 : el.value;
    save();
    if (key !== 'profile' && key !== 'anthropicKey') render();
  }
  if (el.dataset.actChange === 'prop-day') {
    const p = db.chats[ui.weekStart][Number(el.dataset.msg)].proposal;
    p.takeDay[Number(el.dataset.i)] = el.checked;
    save();
    render();
  }
  if (el.dataset.actChange === 'import' && el.files[0]) {
    try {
      importData(await el.files[0].text());
      toast('Backup restored ✓');
    } catch (err) {
      toast(err.message);
    }
  }
  if (el.dataset.wfield) queueSync(D.mondayOf(ui.sheet.date));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.dataset.draft !== undefined && window.matchMedia('(pointer: fine)').matches) {
    e.preventDefault();
    sendToCoach(e.target.value);
  }
});

document.addEventListener('toggle', (e) => {
  if (e.target.tagName === 'DETAILS' && ui.sheet) ui.sheet.editing = e.target.open;
}, true);

// ---------- boot ----------

render();
Coach.warmUp();
W.refresh().then((updated) => updated && render({ background: true })).catch(() => {});
enableDrag((from, id, to) => {
  moveWorkout(from, id, to);
  db.settings.dragHintSeen = true;
  save();
  toast(`Moved to ${D.DOW_LONG[D.dow(to)]}`);
}, (date, id, time) => {
  const w = findWorkout(date, id);
  w.startTime = time;
  w.pinned = true;
  const hour = Number(time.slice(0, 2));
  w.timeOfDay = hour < 11 ? 'morning' : hour < 15 ? 'midday' : 'evening';
  changed(D.mondayOf(date));
  toast(`${w.title} moved to ${D.prettyTime(time)}`);
});
if (Cal.isConnected()) refreshCalendar(ui.weekStart);
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker failed', e));
  // When an update finishes installing, reload once so it takes effect right away.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded && !ui.busy) { reloaded = true; location.reload(); }
  });
}
