// The AI coach: Claude Haiku 5.5, called straight from the phone with a hard weekly spend cap.

import * as D from './dates.js';
import { db, save } from './store.js';
import { TYPE_KEYS, summary, weekRunMiles } from './rules.js';
import { daySummary } from './weather.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm';
const MODEL = 'claude-haiku-5-5';
const MAX_TOKENS = 4000;
// USD per token (Claude Haiku 5.5, prompts under 100K tokens).
const PRICE = { input: 0.10 / 1e6, output: 0.50 / 1e6 };
// Worst case for one call: a generous input estimate plus every output token.
const MAX_CALL_COST = 12_000 * PRICE.input + MAX_TOKENS * PRICE.output;
const HISTORY_TURNS = 8;

export class BudgetError extends Error {}

let sdk = null;
async function client() {
  if (!sdk) sdk = await import(SDK_URL);
  const Anthropic = sdk.default;
  return { Anthropic, client: new Anthropic({ apiKey: db.settings.anthropicKey.trim(), dangerouslyAllowBrowser: true }) };
}

export function spentThisWeek() {
  const start = D.parse(D.mondayOf(D.todayIso())).getTime();
  return db.usage.filter((u) => u.ts >= start).reduce((sum, u) => sum + u.usd, 0);
}

export function canAfford() {
  return spentThisWeek() + MAX_CALL_COST <= db.settings.weeklyBudget;
}

export function cents(usd) {
  const c = usd * 100;
  return c < 0.1 && c > 0 ? '<0.1¢' : `${c.toFixed(c < 10 ? 1 : 0)}¢`;
}

const SYSTEM = `You are Switchback, an upbeat personal exercise planner for one person. You plan their Monday–Sunday week around their calendar, recovery and how they feel. Be opinionated but flexible: recommend a clear plan, and when they push back, re-plan around their choice without arguing (one short sentence on any tradeoff, max). You are not a medical professional; for pain beyond normal soreness, suggest rest and seeing a professional.

Coaching rules:
1. Hard leg days: runs that are moderate/hard or 4+ mi; hikes 5+ mi, 1,200+ ft of gain, or hard; hard strength sessions. Climbing loads fingers, shoulders and back, not legs.
2. Never put two hard leg days back to back. After a big hike, or if they say they're sore, keep the next 24–48 hours easy (walk, stretch; climbing is fine).
3. An easy run on a climbing day is fine (run earlier in the day). No hard or long run on a climbing day.
4. The run right before a likely weekend hike should be the short easy one; put the longer or faster run earlier in the week.
5. Strength is 20–30 min of bodyweight work at home, no equipment. Not the day before climbing. Write the actual exercises and reps in detail.
6. Weekly run mileage grows at most about 10% or 1 mi (whichever is bigger) over last week's completed miles. Hold steady every 4th week. Longest run is at most ~60% of the week's mileage.
7. Alternate the quality run by week: even week number = longer steady run, odd week number = faster run (tempo or intervals, with warm-up and cool-down). Give concrete detail like "1 mi easy, 1.5 mi comfortably hard, 0.5 mi easy".
8. Fill other non-office days with active recovery: a 20–40 min walk and/or 10–15 min of stretching. Keep at least one very light day.
9. Office days get no workouts at all. Fit everything else around calendar events: choose start_time in a free gap with buffer, or null if any time works. Respect any time-of-day preferences in ABOUT ME; if they say mornings are hard, prefer midday or evening and keep any morning session short and easy.
10. Their own changes always win.

How to answer:
- reply: plain text, energetic and warm, at most 70 words. No markdown. When planning a new week, give a 1–2 sentence overview and ask at most 2 quick questions if something important is unknown (e.g. how they feel after a big hike, what the weekend hike might be).
- plan_changed: true only if you are returning an updated plan.
- days: if plan_changed, only the days you are changing, each with its complete new list of workouts (use an empty list to clear a day). Leave out days that stay the same. Never change days before TODAY or anything marked done/skipped. When planning a week from scratch, include every day from TODAY on. If plan_changed is false, return an empty list.
- office_overrides: when they say a specific date is or isn't an office day (e.g. "I'm not going in Tuesday", "office Thursday this week"), list that date with office true or false. Plan that day to match in the same answer. Otherwise an empty list.
- log_entries: activities they say they already did that are not in RECENT ACTIVITY or CURRENT PLAN as done (e.g. "I hiked 4 mi with 2,000 ft yesterday"). feel is 1 (wrecked) to 5 (great), or null if not said. Otherwise an empty list.
- Titles are short (2–3 words, e.g. "Easy run", "Tempo run", "Bodyweight strength", "Lunch walk"). detail is one concrete line.`;

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });
const WORKOUT = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'detail', 'distance_mi', 'minutes', 'time_of_day', 'start_time', 'intensity'],
  properties: {
    type: { type: 'string', enum: TYPE_KEYS },
    title: { type: 'string' },
    detail: { type: 'string' },
    distance_mi: nullable('number'),
    minutes: nullable('integer'),
    time_of_day: { type: 'string', enum: ['morning', 'midday', 'evening', 'anytime'] },
    start_time: { anyOf: [{ type: 'string', format: 'time' }, { type: 'null' }], description: '24h HH:MM' },
    intensity: { type: 'string', enum: ['easy', 'moderate', 'hard'] },
  },
};
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'plan_changed', 'days', 'office_overrides', 'log_entries'],
  properties: {
    reply: { type: 'string' },
    plan_changed: { type: 'boolean' },
    days: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'workouts'],
        properties: { date: { type: 'string', format: 'date' }, workouts: { type: 'array', items: WORKOUT } },
      },
    },
    office_overrides: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'office'],
        properties: { date: { type: 'string', format: 'date' }, office: { type: 'boolean' } },
      },
    },
    log_entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'type', 'title', 'distance_mi', 'elevation_ft', 'minutes', 'feel', 'note'],
        properties: {
          date: { type: 'string', format: 'date' },
          type: { type: 'string', enum: TYPE_KEYS },
          title: { type: 'string' },
          distance_mi: nullable('number'),
          elevation_ft: nullable('integer'),
          minutes: nullable('integer'),
          feel: nullable('integer'),
          note: { type: 'string' },
        },
      },
    },
  },
};

function describeDay(date, list) {
  const items = (list || []).map((w) => {
    const status = w.status === 'planned' ? '' : ` [${w.status.toUpperCase()}${w.feel ? `, felt ${w.feel}/5` : ''}]`;
    const stats = summary(w);
    return `${w.type}: ${w.title}${stats ? ` (${stats})` : ''}${w.intensity !== 'easy' ? `, ${w.intensity}` : ''}${status}${w.note ? ` — "${w.note}"` : ''}`;
  });
  return `${D.DOW[D.dow(date)]} ${date}: ${items.length ? items.join('; ') : 'nothing'}`;
}

function describeCalendar(weekStart, calendar, officeFn) {
  return D.weekDates(weekStart).map((date) => {
    const events = (calendar?.[date] || []).filter((e) => !e.free);
    const bits = [];
    if (officeFn(date)) bits.push('OFFICE DAY (no workouts)');
    for (const e of events) {
      if (e.office) continue;
      const title = e.title; // always "Busy": the app only gets free/busy times
      bits.push(e.allDay ? `all day: ${title}` : `${e.start}–${e.end} ${title}`);
    }
    return `${D.DOW[D.dow(date)]} ${date}: ${bits.length ? bits.join('; ') : 'free'}`;
  }).join('\n');
}

function buildContext({ weekStart, calendar, isOffice, warnings }) {
  const today = D.todayIso();
  const week = db.weeks[weekStart] || { days: {} };
  const prevStart = D.addDays(weekStart, -7);
  const prev = db.weeks[prevStart];

  const recent = [];
  for (let i = 14; i >= 1; i--) {
    const date = D.addDays(today, -i);
    const list = db.weeks[D.mondayOf(date)]?.days?.[date]?.filter((w) => w.status !== 'planned');
    if (list?.length) recent.push(describeDay(date, list));
  }

  return [
    `TODAY: ${D.DOW_LONG[D.dow(today)]} ${today}`,
    `TARGET WEEK: ${weekStart} to ${D.addDays(weekStart, 6)} (week number ${D.weekIndex(weekStart)})`,
    `ABOUT ME:\n${db.settings.profile.trim() || '(not filled in yet — ask one quick question about their usual week)'}`,
    `RUN MILES COMPLETED THE WEEK BEFORE: ${weekRunMiles(prev, { doneOnly: true }) || 'unknown (assume about 5)'}`,
    `RECENT ACTIVITY (last 14 days):\n${recent.join('\n') || 'nothing logged'}`,
    `CALENDAR:\n${describeCalendar(weekStart, calendar, isOffice)}`,
    db.settings.weatherPlace && db.weather
      ? `WEATHER (${db.settings.weatherPlace.name}; prefer dry, mild hours for outdoor runs, hikes and walks):\n${D.weekDates(weekStart).map((d) => `${D.DOW[D.dow(d)]} ${d}: ${daySummary(d) || 'no forecast yet'}`).join('\n')}`
      : '',
    `CURRENT PLAN:\n${D.weekDates(weekStart).map((d) => describeDay(d, week.days[d])).join('\n')}`,
    warnings.length ? `RULE CHECK WARNINGS:\n${warnings.map((w) => `- ${w.text}`).join('\n')}` : '',
    week.manualChange ? `CHANGES I MADE MYSELF (keep these): ${week.manualChange}` : '',
  ].filter(Boolean).join('\n\n');
}

// Load the SDK in the background when the app opens, so the first message isn't slowed down.
export function warmUp() {
  if (db.settings.anthropicKey.trim() && !sdk) client().catch(() => {});
}

// The reply is the first field of the JSON, so it can be shown while the plan is still being written.
function partialReply(json) {
  const m = json.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!m) return '';
  const body = m[1].replace(/\\u?[0-9a-fA-F]{0,3}$|\\$/, ''); // drop a half-received escape
  try {
    return JSON.parse(`"${body}"`);
  } catch {
    return body;
  }
}

// Sends one message to the coach. Returns { reply, days, logEntries, cost }.
// onReply(text) is called with the reply so far as it streams in.
export async function ask({ weekStart, text, calendar, isOffice, warnings, onReply = () => {} }) {
  if (!db.settings.anthropicKey.trim()) throw new Error('Add your Anthropic API key in Settings to use the coach.');
  if (!canAfford()) {
    throw new BudgetError(`Weekly AI budget reached (${cents(spentThisWeek())} of ${cents(db.settings.weeklyBudget)}). The coach is back Monday — you can still edit the plan by hand.`);
  }

  const history = (db.chats[weekStart] || []).slice(-HISTORY_TURNS);
  while (history.length && history[0].role !== 'user') history.shift();
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.text })),
    { role: 'user', content: `${buildContext({ weekStart, calendar, isOffice, warnings })}\n\nMESSAGE:\n${text}` },
  ];

  const { Anthropic, client: c } = await client();
  let response;
  try {
    const stream = c.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages,
    });
    let soFar = '';
    stream.on('text', (delta) => {
      soFar += delta;
      const reply = partialReply(soFar);
      if (reply) onReply(reply);
    });
    response = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key. Check it in Settings.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic is rate-limiting right now. Try again in a minute.');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Could not reach Anthropic. Are you online?');
    if (e instanceof Anthropic.APIError) throw new Error(`Anthropic error: ${e.message}`);
    throw e;
  }

  const u = response.usage;
  const cost = (u.input_tokens + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1) * PRICE.input
    + u.output_tokens * PRICE.output;
  db.usage.push({ ts: Date.now(), usd: cost, input: u.input_tokens, output: u.output_tokens });
  db.usage = db.usage.filter((x) => x.ts > Date.now() - 60 * 864e5);
  save();

  if (response.stop_reason === 'refusal') throw new Error('The coach declined to answer that one. Try rephrasing.');
  if (response.stop_reason === 'max_tokens') throw new Error('The coach ran out of room. Try a shorter request.');

  const textBlock = response.content.find((b) => b.type === 'text');
  let out;
  try {
    out = JSON.parse(textBlock.text);
  } catch {
    throw new Error('The coach sent back something unreadable. Try again.');
  }
  return {
    reply: out.reply,
    days: out.plan_changed ? out.days : null,
    officeOverrides: out.office_overrides || [],
    logEntries: out.log_entries || [],
    cost,
  };
}
