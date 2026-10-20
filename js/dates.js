// Date helpers. Everything is local time; dates are 'YYYY-MM-DD' strings.

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');

export function iso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parse(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, n) {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return iso(d);
}

export function todayIso() {
  return iso(new Date());
}

export function dow(s) {
  return parse(s).getDay();
}

export function mondayOf(s) {
  const day = dow(s);
  return addDays(s, day === 0 ? -6 : 1 - day);
}

export function weekDates(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

// On Sunday you're planning the week ahead, so default to next Monday.
export function defaultWeekStart() {
  const t = todayIso();
  return dow(t) === 0 ? addDays(t, 1) : mondayOf(t);
}

export function shortDate(s) {
  const d = parse(s);
  return `${MON[d.getMonth()]} ${d.getDate()}`;
}

export function weekLabel(weekStart) {
  const end = addDays(weekStart, 6);
  const a = parse(weekStart), b = parse(end);
  return a.getMonth() === b.getMonth()
    ? `${MON[a.getMonth()]} ${a.getDate()}–${b.getDate()}`
    : `${shortDate(weekStart)} – ${shortDate(end)}`;
}

// Week number since a fixed Monday, used to alternate long vs fast run weeks.
export function weekIndex(weekStart) {
  return Math.round((parse(weekStart) - parse('2026-01-05')) / (7 * 864e5));
}

export function hhmm(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// '18:30' -> '6:30p'
export function prettyTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'p' : 'a';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${pad(m)}${suffix}` : `${h12}${suffix}`;
}
