// Google Calendar: read only when you're busy, write workouts to a
// separate "Workouts" calendar so Google sends the reminders.

import * as D from './dates.js';
import { db, save } from './store.js';
import { TYPES, estimateMinutes, DEFAULT_START } from './rules.js';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly', // which calendars you have (names only)
  'https://www.googleapis.com/auth/calendar.freebusy', // when you're busy, never event details
  'https://www.googleapis.com/auth/calendar.app.created', // only calendars this app creates
].join(' ');
const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_KEY = 'switchback.gtoken';
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Google Calendar event colors that roughly match the app.
const COLOR_IDS = { run: '6', climb: '3', hike: '10', strength: '5', walk: '7', stretch: '4' };

export class AuthNeeded extends Error {}

let tokenClient = null;

function storedToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    return t && t.exp > Date.now() + 60_000 ? t.token : null;
  } catch {
    return null;
  }
}

export function isConnected() {
  return !!storedToken();
}

export function wasEverConnected() {
  return !!db.settings.workoutsCalendarId || !!localStorage.getItem(TOKEN_KEY);
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Google sign-in. Are you online?'));
    document.head.appendChild(s);
  });
}

// Must be called from a tap (Google opens a popup).
export async function connect() {
  const clientId = db.settings.googleClientId.trim();
  if (!clientId) throw new Error('Add your Google client ID in Settings first.');
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error) return reject(new Error(`Google said: ${resp.error}`));
        localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: resp.access_token, exp: Date.now() + resp.expires_in * 1000 }));
        resolve();
      },
      error_callback: (err) => reject(new Error(err?.message || 'Google sign-in was closed.')),
    });
    tokenClient.requestAccessToken({ prompt: wasEverConnected() ? '' : 'consent' });
  });
}

export function disconnect() {
  const token = storedToken();
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token);
  localStorage.removeItem(TOKEN_KEY);
}

async function api(path, { method = 'GET', params, body } = {}) {
  const token = storedToken();
  if (!token) throw new AuthNeeded('Reconnect Google Calendar.');
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    throw new AuthNeeded('Google session expired. Tap to reconnect.');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Google Calendar error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function listAll(path, params) {
  const items = [];
  let pageToken;
  do {
    const page = await api(path, { params: { ...params, pageToken } });
    items.push(...(page.items || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

const enc = encodeURIComponent;

function weekRange(weekStart) {
  const start = D.parse(weekStart);
  const end = D.parse(D.addDays(weekStart, 7));
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

// Returns { 'YYYY-MM-DD': [{ title: 'Busy', start, end, allDay }] } for the week.
// Only free/busy times are requested: Google never sends event names or details.
export async function fetchWeek(weekStart) {
  const calendars = (await listAll('/users/me/calendarList', { minAccessRole: 'freeBusyReader' }))
    .filter((c) => c.selected !== false && c.id !== db.settings.workoutsCalendarId);
  const { timeMin, timeMax } = weekRange(weekStart);
  const dates = D.weekDates(weekStart);
  const byDay = Object.fromEntries(dates.map((d) => [d, []]));
  if (!calendars.length) return byDay;

  const fb = await api('/freeBusy', { method: 'POST', body: { timeMin, timeMax, timeZone: TZ, items: calendars.map((c) => ({ id: c.id })) } });
  const blocks = Object.values(fb.calendars || {})
    .flatMap((c) => c.busy || [])
    .map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()])
    .sort((a, b) => a[0] - b[0]);

  // Merge overlapping blocks across calendars, then split any that cross midnight.
  const merged = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1]);
    else merged.push([...b]);
  }
  for (const [start, end] of merged) {
    for (let s = start; s < end;) {
      const day = D.iso(new Date(s));
      const midnight = D.parse(D.addDays(day, 1)).getTime();
      const e = Math.min(end, midnight);
      if (byDay[day]) {
        const allDay = e - s >= 23 * 3600_000;
        byDay[day].push(allDay
          ? { title: 'Busy all day', allDay: true }
          : { title: 'Busy', allDay: false, start: D.hhmm(new Date(s)), end: e === midnight ? '23:59' : D.hhmm(new Date(e)) });
      }
      s = e;
    }
  }
  return byDay;
}

async function ensureWorkoutsCalendar() {
  const id = db.settings.workoutsCalendarId;
  if (id) {
    try {
      await api(`/calendars/${enc(id)}`);
      return id;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  const cal = await api('/calendars', { method: 'POST', body: { summary: 'Workouts', description: 'Planned by Switchback', timeZone: TZ } });
  db.settings.workoutsCalendarId = cal.id;
  save();
  return cal.id;
}

function eventBody(w, date) {
  const startTime = w.startTime || DEFAULT_START[w.timeOfDay] || '10:00';
  const start = new Date(`${date}T${startTime}:00`);
  const end = new Date(start.getTime() + estimateMinutes(w) * 60_000);
  const local = (d) => `${D.iso(d)}T${D.hhmm(d)}:00`;
  const done = w.status === 'done';

  const overrides = [];
  if (!done) {
    overrides.push({ method: 'popup', minutes: db.settings.reminderMinutes });
    // A 9pm heads-up the night before morning workouts: lay out your clothes.
    if (db.settings.nightBeforeNudge && start.getHours() < 10) {
      const ninePm = new Date(`${D.addDays(date, -1)}T21:00:00`);
      overrides.push({ method: 'popup', minutes: Math.round((start - ninePm) / 60_000) });
    }
  }
  const stats = [w.distanceMi && `${w.distanceMi} mi`, w.minutes && `${w.minutes} min`].filter(Boolean).join(' · ');
  return {
    summary: `${done ? '✅' : TYPES[w.type].emoji} ${w.title}${stats ? ` — ${stats}` : ''}`,
    description: [w.detail, w.note].filter(Boolean).join('\n\n'),
    start: { dateTime: local(start), timeZone: TZ },
    end: { dateTime: local(end), timeZone: TZ },
    colorId: COLOR_IDS[w.type],
    reminders: { useDefault: false, overrides },
    transparency: 'transparent', // a planned workout shouldn't block your calendar
    extendedProperties: { private: { switchback: '1', switchbackId: w.id } },
  };
}

// Make the Workouts calendar match the week's plan.
export async function syncWeek(weekStart, week) {
  const calId = await ensureWorkoutsCalendar();
  const existing = await listAll(`/calendars/${enc(calId)}/events`, {
    ...weekRange(weekStart), singleEvents: 'true', privateExtendedProperty: 'switchback=1', maxResults: 250,
  });
  const byId = new Map(existing.map((e) => [e.extendedProperties?.private?.switchbackId, e]));

  for (const date of D.weekDates(weekStart)) {
    for (const w of week.days[date] || []) {
      if (w.type === 'rest' || w.status === 'skipped') continue;
      const body = eventBody(w, date);
      const ev = byId.get(w.id);
      byId.delete(w.id);
      if (!ev) {
        await api(`/calendars/${enc(calId)}/events`, { method: 'POST', body });
      } else if (ev.summary !== body.summary || ev.description !== (body.description || undefined)
        || !sameTime(ev.start, body.start) || !sameTime(ev.end, body.end)) {
        await api(`/calendars/${enc(calId)}/events/${enc(ev.id)}`, { method: 'PATCH', body });
      }
    }
  }
  for (const ev of byId.values()) {
    await api(`/calendars/${enc(calId)}/events/${enc(ev.id)}`, { method: 'DELETE' });
  }
}

const sameTime = (a, b) => new Date(a.dateTime).getTime() === new Date(b.dateTime).getTime();

// A repeating reminder event on the Workouts calendar; `key` is the setting that remembers its id.
async function ensureRepeatingReminder({ key, summary, appUrl, firstDate, time, rrule }) {
  const calId = await ensureWorkoutsCalendar();
  const id = db.settings[key];
  if (id) {
    try {
      const ev = await api(`/calendars/${enc(calId)}/events/${enc(id)}`);
      if (ev.status !== 'cancelled') return;
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e;
    }
  }
  const [h, m] = time.split(':').map(Number);
  const end = `${String(h).padStart(2, '0')}:${String(m + 15).padStart(2, '0')}`;
  const ev = await api(`/calendars/${enc(calId)}/events`, {
    method: 'POST',
    body: {
      summary,
      description: `Open Switchback: ${appUrl}`,
      start: { dateTime: `${firstDate}T${time}:00`, timeZone: TZ },
      end: { dateTime: `${firstDate}T${end}:00`, timeZone: TZ },
      recurrence: [rrule],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
      transparency: 'transparent',
      extendedProperties: { private: { switchbackReminder: '1' } },
    },
  });
  db.settings[key] = ev.id;
  save();
}

// A weekly "plan your week" event on Sunday evenings.
export function ensureSundayReminder(appUrl) {
  const today = D.todayIso();
  return ensureRepeatingReminder({
    key: 'sundayReminderId', summary: '🥾 Plan your week in Switchback', appUrl,
    firstDate: D.addDays(today, (7 - D.dow(today)) % 7), time: '18:00', rrule: 'RRULE:FREQ=WEEKLY;BYDAY=SU',
  });
}

// A daily 8pm nudge to check in on your one thing.
export function ensureCheckinReminder(appUrl) {
  return ensureRepeatingReminder({
    key: 'checkinReminderId', summary: '☀️ Did you do your one thing today?', appUrl,
    firstDate: D.todayIso(), time: '20:00', rrule: 'RRULE:FREQ=DAILY',
  });
}
