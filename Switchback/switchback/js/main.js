import * as D from './dates.js';
import { db, save, getWeek, dayWorkouts, hasPlan, exportData, importData } from './store.js';
import { TYPES, TYPE_KEYS, workout, warningsFor, isOfficeDay, starterWeek, summary, weekRunMiles } from './rules.js';
import * as Cal from './calendar.js';
import * as Coach from './coach.js';
import * as P from './progress.js';

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
};

const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (name) => `<i class="ti ti-${name}" aria-hidden="true"></i>`;
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

function applyPlan(ws, days) {
  const week = getWeek(ws);
  const today = D.todayIso();
  const valid = new Set(D.weekDates(ws));
  for (const day of days) {
    if (!valid.has(day.date) || day.date < today) continue; // the past is the past
    const old = week.days[day.date] || [];
    const kept = old.filter((w) => w.status !== 'planned');
    const pool = old.filter((w) => w.status === 'planned');
    const fresh = day.workouts
      .filter((nw) => !kept.some((k) => k.type === nw.type))
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

async function sendToCoach(text) {
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
    const res = await Coach.ask({ weekStart: ws, text, calendar: calendarFor(ws), isOffice: officeFn(ws), warnings: currentWarnings(ws) });
    const chat = (db.chats[ws] ||= []);
    chat.push({ role: 'user', text, ts: Date.now() });
    chat.push({ role: 'assistant', text: res.reply, ts: Date.now(), cost: res.cost, planChanged: !!res.days, logged: res.logEntries.length });
    res.logEntries.forEach(addLogEntry);
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
    render();
    scrollChat();
  }
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
  const showWeek = ui.view !== 'settings';
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
  const { total, done } = P.weekProgress(week);
  const planned = weekRunMiles(week);
  const ran = weekRunMiles(week, { doneOnly: true });
  const streak = P.summitStreak(ws);
  // Animate the newest marker once you're back on the week (not behind an open sheet).
  const pop = ui.popWeek === ws && !ui.sheet;
  if (pop) ui.popWeek = null;
  return `
    <section class="hero">
      <div class="hero-main">
        ${total
          ? `<div class="hero-count">${done}<small> of ${total}</small></div><div class="hero-label">workouts done</div>`
          : '<div class="hero-title">New week, new trail</div>'}
        <div class="hero-msg">${esc(P.trailMessage(week))}</div>
        <div class="hero-chips">
          ${planned ? `<span class="mini-chip">${ic('run')} ${ran} of ${planned} mi</span>` : ''}
          ${streak >= 2 ? `<span class="mini-chip sun">${ic('flag')} ${streak}-week streak</span>` : ''}
        </div>
      </div>
      ${P.trailSvg(week, { pop })}
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

function workoutButton(w, date) {
  const t = TYPES[w.type] || TYPES.walk;
  const meta = summary(w);
  return `
    <button class="wk s-${w.status}" style="--c:${t.color}" data-act="open" data-date="${date}" data-id="${w.id}">
      <span class="wk-icon">${ic(t.icon)}</span>
      <span class="wk-main"><b>${esc(w.title || t.label)}</b>${meta ? `<small>${esc(meta)}</small>` : ''}</span>
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
      ? `<div class="banner"><span>You changed the plan.</span><button class="cta small" data-act="rebalance">${ic('sparkles')} Rebalance the rest</button></div>`
      : '';

  const general = warnings.filter((w) => !w.date);
  const days = D.weekDates(ws).map((date) => {
    const list = week.days[date] || [];
    const events = (cal?.[date] || []).map(eventLine).filter(Boolean);
    const dayWarn = warnings.filter((w) => w.date === date);
    const office = isOfficeDay(date, db.settings, cal);
    return `
      <section class="day ${date === today ? 'today' : ''} ${date < today ? 'past' : ''}">
        <div class="day-head">
          <div class="dname">${D.DOW[D.dow(date)]}</div>
          <div class="dnum">${D.parse(date).getDate()}</div>
          ${date === today ? '<span class="badge hot">Today</span>' : ''}
          ${office ? `<span class="badge">${ic('building')} Office</span>` : ''}
          <button class="add" data-act="add" data-date="${date}" aria-label="Add to ${D.DOW[D.dow(date)]}">${ic('plus')}</button>
        </div>
        ${events.length ? `<ul class="events">${events.slice(0, 3).join('')}${events.length > 3 ? `<li class="more">+${events.length - 3} more</li>` : ''}</ul>` : ''}
        <div class="wks">${list.map((w) => workoutButton(w, date)).join('') || `<div class="empty">${office ? 'Office day — no workouts' : 'Nothing planned'}</div>`}</div>
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
    ${planned ? `<button class="ghost" data-act="nav" data-view="coach">${ic('message-circle')} Talk to your coach</button>` : ''}`;
}

function coachView() {
  const ws = ui.weekStart;
  const chat = db.chats[ws] || [];
  const hasKey = !!db.settings.anthropicKey.trim();
  const chips = !hasPlan(ws)
    ? ['Plan my week']
    : ["I'm sore today", 'Something came up', 'Swap two days', 'Rebalance the rest of the week'];

  const bubbles = chat.map((m) => `
    <div class="msg ${m.role}">
      <p>${esc(m.text)}</p>
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
      ${ui.pending ? `<div class="msg user"><p>${esc(ui.pending)}</p></div><div class="msg assistant typing"><i></i><i></i><i></i></div>` : ''}
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
        <label>OAuth client ID
          <input type="text" autocomplete="off" data-setting="googleClientId" value="${esc(s.googleClientId)}" placeholder="….apps.googleusercontent.com">
        </label>
        <div class="row">
          ${connected
            ? '<button class="btn" data-act="cal-disconnect">Disconnect</button><button class="btn" data-act="sunday">Add Sunday reminder</button>'
            : `<button class="btn primary" data-act="cal-connect" ${s.googleClientId ? '' : 'disabled'}>Connect Google Calendar</button>`}
        </div>
        ${s.sundayReminderId ? '<p class="hint">✓ Sunday 6pm “Plan your week” reminder is on your Workouts calendar.</p>' : ''}
        <label class="check"><input type="checkbox" data-setting="shareEventTitles" ${s.shareEventTitles ? 'checked' : ''}> Let the coach see event names (otherwise just “busy”)</label>
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
    body = `<div class="sheet-kicker">Add · ${esc(dayName)}</div>${workoutForm(workout({ type: s.type || 'run', title: '' }), s.date, true)}`;
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
      <button class="btn danger wide" data-act="delete">Delete</button>`;
  }
  return `<div class="backdrop" data-act="close"></div><div class="sheet" role="dialog">${body}</div>`;
}

function nav() {
  const item = (view, icon, label) => `<button class="${ui.view === view ? 'on' : ''}" data-act="nav" data-view="${view}"><span>${ic(icon)}</span>${label}</button>`;
  return `<nav class="tabs">${item('week', 'calendar-week', 'Week')}${item('coach', 'message-circle', 'Coach')}${item('settings', 'settings', 'Settings')}</nav>`;
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

  const view = ui.view === 'coach' ? coachView() : ui.view === 'settings' ? settingsView() : weekView();
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

const actions = {
  nav: (el) => { ui.view = el.dataset.view; ui.sheet = null; render(); if (ui.view === 'coach') scrollChat(); },
  week: (el) => {
    ui.weekStart = D.addDays(ui.weekStart, Number(el.dataset.delta));
    ui.chatError = '';
    render();
    if (!calendarFor(ui.weekStart)) refreshCalendar(ui.weekStart);
  },
  plan: startPlanning,
  rebalance: () => sendToCoach(`I changed the plan myself: ${getWeek(ui.weekStart).manualChange} Keep my changes and rebalance the rest of the week around them.`),
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
      ui.popWeek = ws;
      toast(P.doneCheer(getWeek(ws)));
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
    const ws = D.mondayOf(date);
    const from = dayWorkouts(ws, date);
    const w = from.splice(from.findIndex((x) => x.id === id), 1)[0];
    dayWorkouts(ws, to).push(w);
    ui.sheet = { ...ui.sheet, date: to };
    changed(ws, `Moved ${w.title} from ${D.DOW[D.dow(date)]} to ${D.DOW[D.dow(to)]}.`);
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
  sunday: async () => {
    try {
      await Cal.ensureSundayReminder(location.origin + location.pathname);
      toast('Sunday reminder added ✓');
    } catch (e) {
      toast(e.message);
    }
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
  const data = readForm(form);
  const { date } = ui.sheet;
  const ws = D.mondayOf(date);
  if (form.dataset.form === 'add') {
    const { done, ...fields } = data;
    dayWorkouts(ws, date).push(workout({ ...fields, status: done ? 'done' : 'planned', source: done ? 'logged' : 'plan' }));
    ui.sheet = null;
    changed(ws, done ? '' : `Added ${fields.title} on ${D.DOW[D.dow(date)]}.`);
    if (done) ui.popWeek = ws;
    toast(done ? P.doneCheer(getWeek(ws)) : 'Added to plan');
  } else {
    const w = findWorkout(date, ui.sheet.id);
    const { done, ...fields } = data;
    Object.assign(w, fields);
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
if (Cal.isConnected()) refreshCalendar(ui.weekStart);
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker failed', e));
}
