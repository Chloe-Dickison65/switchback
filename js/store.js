// All app data lives in one localStorage entry on the phone.

const KEY = 'switchback.v1';

const DEFAULTS = {
  settings: {
    anthropicKey: '',
    googleClientId: '',
    weeklyBudget: 0.10,
    officeDays: [], // 0=Sun … 6=Sat
    profile: '', // filled in on the phone, so personal details never live in the code
    reminderMinutes: 30,
    nightBeforeNudge: true,
    workoutsCalendarId: '',
    sundayReminderId: '',
    weatherPlace: null, // { name, lat, lon } typed in Settings
  },
  weeks: {},    // weekStart -> { days: { date: [workout] }, manualChange, synced }
  chats: {},    // weekStart -> [{ role, text, ts, cost }]
  usage: [],    // [{ ts, usd, input, output }]
  calCache: {}, // weekStart -> { date: [event] }
  weather: null,  // cached hourly forecast
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const data = JSON.parse(raw);
      return { ...structuredClone(DEFAULTS), ...data, settings: { ...DEFAULTS.settings, ...data.settings } };
    }
  } catch (e) {
    console.warn('Could not load saved data', e);
  }
  return structuredClone(DEFAULTS);
}

export const db = load();

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch (e) {
    console.warn('Could not save', e);
  }
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function getWeek(weekStart) {
  if (!db.weeks[weekStart]) db.weeks[weekStart] = { days: {}, manualChange: '', synced: false };
  return db.weeks[weekStart];
}

export function dayWorkouts(weekStart, date) {
  const week = getWeek(weekStart);
  if (!week.days[date]) week.days[date] = [];
  return week.days[date];
}

export function hasPlan(weekStart) {
  const w = db.weeks[weekStart];
  // Logged-only activity (e.g. an unplanned hike) doesn't count as having a plan.
  return !!w && Object.values(w.days).some((list) => list.some((x) => x.source !== 'logged'));
}

export function exportData() {
  const { anthropicKey, ...settings } = db.settings; // never put the API key in a backup file
  return JSON.stringify({ ...db, settings }, null, 2);
}

export function importData(text) {
  const data = JSON.parse(text);
  if (!data.weeks || !data.settings) throw new Error('That file is not a Switchback backup.');
  const key = db.settings.anthropicKey;
  Object.assign(db, structuredClone(DEFAULTS), data);
  db.settings = { ...DEFAULTS.settings, ...data.settings, anthropicKey: key };
  save();
}
