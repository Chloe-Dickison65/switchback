// Workout types, recovery rules, and the starter plan used when the AI coach is off.

import * as D from './dates.js';
import { db, uid } from './store.js';

// emoji is used in Google Calendar event titles; icon is the in-app Tabler icon.
export const TYPES = {
  run:      { label: 'Run',      emoji: '🏃', icon: 'run', color: 'var(--run)' },
  climb:    { label: 'Climb',    emoji: '🧗', icon: 'hand-grab', color: 'var(--climb)' },
  hike:     { label: 'Hike',     emoji: '🥾', icon: 'mountain', color: 'var(--hike)' },
  strength: { label: 'Strength', emoji: '💪', icon: 'barbell', color: 'var(--strength)' },
  walk:     { label: 'Walk',     emoji: '🚶', icon: 'walk', color: 'var(--walk)' },
  stretch:  { label: 'Stretch',  emoji: '🧘', icon: 'stretching', color: 'var(--stretch)' },
  rest:     { label: 'Rest',     emoji: '😴', icon: 'zzz', color: 'var(--rest)' },
};

export const TYPE_KEYS = Object.keys(TYPES);

export function workout(fields) {
  return {
    id: uid(),
    type: 'walk',
    title: '',
    detail: '',
    distanceMi: null,
    elevationFt: null,
    minutes: null,
    timeOfDay: 'anytime',
    startTime: null,
    intensity: 'easy',
    status: 'planned', // planned | done | skipped
    feel: null,        // 1 (wrecked) … 5 (great)
    note: '',
    source: 'plan',    // plan | logged
    ...fields,
  };
}

// How much a workout taxes the legs: 0 none, 1 light, 2 solid, 3 big.
export function legLoad(w) {
  if (w.status === 'skipped') return 0;
  const mi = w.distanceMi || 0;
  switch (w.type) {
    case 'run':
      if (w.intensity === 'hard' || mi >= 6) return 3;
      if (w.intensity === 'moderate' || mi >= 4) return 2;
      return 1;
    case 'hike':
      if (w.intensity === 'hard' || mi >= 8 || (w.elevationFt || 0) >= 2500) return 3;
      if (w.intensity === 'moderate' || mi >= 5 || (w.elevationFt || 0) >= 1200) return 2;
      return 1;
    case 'strength':
      return w.intensity === 'hard' ? 2 : 1; // short bodyweight sessions are light on the legs
    default:
      return 0;
  }
}

export function weekRunMiles(week, { doneOnly = false } = {}) {
  let total = 0;
  for (const list of Object.values(week?.days || {})) {
    for (const w of list) {
      if (w.type !== 'run' || w.status === 'skipped') continue;
      if (doneOnly && w.status !== 'done') continue;
      total += Number(w.distanceMi) || 0;
    }
  }
  return Math.round(total * 10) / 10;
}

const active = (list) => (list || []).filter((w) => w.status !== 'skipped' && w.type !== 'rest');
const maxLeg = (list) => Math.max(0, ...active(list).map(legLoad));
const label = (date) => D.DOW[D.dow(date)];

// Returns [{ date, text }] describing rule conflicts in a week's plan.
export function warningsFor(weekStart, week, settings, calendar, prevWeek) {
  const out = [];
  const dates = D.weekDates(weekStart);
  // Include the Sunday before so a big weekend hike affects Monday.
  const prevSunday = D.addDays(weekStart, -1);
  const listFor = (date) => (date === prevSunday ? prevWeek?.days?.[date] : week.days[date]) || [];

  for (const date of dates) {
    const list = active(listFor(date));
    if (isOfficeDay(date, settings, calendar) && list.some((w) => !['walk', 'stretch'].includes(w.type))) {
      out.push({ date, text: `${label(date)} is an office day, but has a workout.` });
    }
  }

  for (const date of [prevSunday, ...dates.slice(0, 6)]) {
    const next = D.addDays(date, 1);
    const a = listFor(date), b = listFor(next);
    const sore = a.some((w) => w.status === 'done' && w.feel && w.feel <= 2);
    if (maxLeg(a) >= 2 && maxLeg(b) >= 2) {
      out.push({ date: next, text: `Back-to-back hard leg days: ${label(date)} → ${label(next)}.` });
    } else if (sore && maxLeg(b) >= 2) {
      out.push({ date: next, text: `You felt beat up after ${label(date)} — ${label(next)} looks hard.` });
    }
    const climbNext = b.some((w) => w.type === 'climb' && w.status !== 'skipped');
    if (climbNext && active(a).some((w) => w.type === 'strength')) {
      out.push({ date, text: `Strength on ${label(date)} will tire you out for climbing on ${label(next)}.` });
    }
    const hardRunWithClimb = active(b).some((w) => w.type === 'run' && legLoad(w) >= 2)
      && active(b).some((w) => w.type === 'climb');
    if (hardRunWithClimb) {
      out.push({ date: next, text: `${label(next)} has a hard run and climbing — keep that run easy.` });
    }
  }

  const easyDays = dates.filter((d) => maxLeg(week.days[d]) <= 1 && !active(week.days[d]).some((w) => w.type === 'climb'));
  if (easyDays.length === 0) out.push({ date: null, text: 'No recovery day this week. Add an easy walk + stretch day.' });

  const prevMiles = weekRunMiles(prevWeek, { doneOnly: true });
  const planned = weekRunMiles(week);
  const cap = Math.max(prevMiles * 1.1, prevMiles + 1.5);
  if (prevMiles > 0 && planned > cap) {
    out.push({ date: null, text: `${planned} mi planned vs ${prevMiles} mi last week — that's a big jump.` });
  }

  // De-duplicate identical messages.
  return out.filter((w, i) => out.findIndex((x) => x.text === w.text) === i);
}

// A one-off change for a specific date ("not in the office this Tuesday") beats the weekly setting.
export function isOfficeDay(date, settings, calendar) {
  const override = db.weeks[D.mondayOf(date)]?.officeOverrides?.[date];
  if (override !== undefined) return override;
  if (settings.officeDays.includes(D.dow(date))) return true;
  return (calendar?.[date] || []).some((e) => e.office);
}

// A sensible week without the AI: climb Monday, longer/faster run midweek,
// short easy run before the weekend, strength Thursday, hike Saturday,
// walks and stretching everywhere else. Office days stay empty.
export function starterWeek(weekStart, settings, calendar, prevWeek) {
  const dates = D.weekDates(weekStart);
  const office = (d) => isOfficeDay(d, settings, calendar);
  const days = Object.fromEntries(dates.map((d) => [d, []]));
  const free = (d) => !office(d) && days[d].length === 0;

  const prevMiles = weekRunMiles(prevWeek, { doneOnly: true }) || 5;
  const target = Math.round(Math.min(prevMiles * 1.1, prevMiles + 1) * 2) / 2;
  const longMi = Math.max(2.5, Math.round(target * 0.6 * 2) / 2);
  const easyMi = Math.max(2, Math.round((target - longMi) * 2) / 2);
  const fastWeek = D.weekIndex(weekStart) % 2 === 1;

  const [mon, tue, wed, thu, fri, sat, sun] = dates;
  if (!office(mon)) {
    days[mon].push(workout({ type: 'climb', title: 'Climbing', detail: 'Bouldering or ropes — your call.', timeOfDay: 'evening', intensity: 'moderate', minutes: 120 }));
  }

  const pick = (prefs) => prefs.find((d) => d && free(d));
  const qualityDay = pick([wed, thu, tue]);
  if (qualityDay) {
    days[qualityDay].push(fastWeek
      ? workout({ type: 'run', title: 'Tempo run', detail: `1 mi easy, ${Math.max(1, longMi - 2)} mi comfortably hard, 1 mi easy.`, distanceMi: longMi, timeOfDay: 'evening', intensity: 'moderate' })
      : workout({ type: 'run', title: 'Longer run', detail: 'Steady, conversational pace. Walk breaks are fine.', distanceMi: longMi, timeOfDay: 'evening', intensity: 'moderate' }));
  }
  const easyDay = pick([fri, thu, sun].filter((d) => d !== qualityDay && D.addDays(d, -1) !== qualityDay)) || pick([fri, sun]);
  if (easyDay) {
    days[easyDay].push(workout({ type: 'run', title: 'Easy run', detail: 'Relaxed — you should be able to chat.', distanceMi: easyMi, timeOfDay: 'midday', intensity: 'easy' }));
  }
  const beforeQuality = qualityDay ? D.addDays(qualityDay, -1) : null;
  const strengthDay = pick([thu, tue, sun].filter((d) => D.addDays(d, 1) !== mon && d !== beforeQuality));
  if (strengthDay) {
    days[strengthDay].push(workout({ type: 'strength', title: 'Bodyweight strength', detail: '3 rounds: 12 squats, 10 lunges/leg, 8 push-ups, 30s plank, 12 glute bridges.', minutes: 25, timeOfDay: 'evening', intensity: 'moderate' }));
  }
  if (free(sat)) {
    days[sat].push(workout({ type: 'hike', title: 'Hike', detail: 'Any distance — log the real numbers after.', timeOfDay: 'anytime', intensity: 'moderate' }));
  }
  for (const d of dates) {
    if (office(d)) continue;
    if (days[d].length === 0) {
      days[d].push(workout({ type: 'walk', title: 'Walk', detail: '30 minutes, any pace.', minutes: 30, timeOfDay: 'midday' }));
    }
    if (!days[d].some((w) => w.type === 'climb' || w.type === 'hike')) {
      days[d].push(workout({ type: 'stretch', title: 'Stretch', detail: 'Hips, hamstrings, calves, shoulders.', minutes: 10, timeOfDay: 'evening' }));
    }
  }
  return days;
}

export function summary(w) {
  const bits = [];
  if (w.distanceMi) bits.push(`${w.distanceMi} mi`);
  if (w.elevationFt) bits.push(`${w.elevationFt.toLocaleString()} ft`);
  if (w.minutes && !w.distanceMi) bits.push(`${w.minutes} min`);
  const when = w.startTime ? D.prettyTime(w.startTime) : (w.timeOfDay !== 'anytime' ? w.timeOfDay : '');
  if (when) bits.push(when);
  return bits.join(' · ');
}

export function estimateMinutes(w) {
  if (w.minutes) return w.minutes;
  if (w.type === 'run' && w.distanceMi) return Math.round(w.distanceMi * 11 + 10);
  if (w.type === 'hike' && w.distanceMi) return Math.round(w.distanceMi * 25);
  return { climb: 120, hike: 180, strength: 25, walk: 30, stretch: 10 }[w.type] || 30;
}

export const DEFAULT_START = { morning: '07:00', midday: '12:00', evening: '18:00', anytime: '10:00' };

// When a workout happens: its own start time, or a sensible default for its time of day.
export function workoutWindow(w) {
  const start = w.startTime || DEFAULT_START[w.timeOfDay] || '10:00';
  const [h, m] = start.split(':').map(Number);
  const endMin = Math.min(h * 60 + m + estimateMinutes(w), 23 * 60 + 59);
  return { start, end: `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}` };
}
