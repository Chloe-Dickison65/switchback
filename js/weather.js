// Hourly forecast from Open-Meteo (free, no account or key). Uses the city you
// type in Settings, never your phone's location.

import { db, save } from './store.js';

const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const MAX_AGE = 60 * 60 * 1000; // refresh hourly
export const OUTDOOR = new Set(['run', 'hike', 'walk']);

export async function findPlace(query) {
  const url = `${GEO}?count=1&language=en&name=${encodeURIComponent(query.trim())}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not look up that place. Are you online?');
  const hit = (await res.json()).results?.[0];
  if (!hit) throw new Error(`Couldn't find "${query}". Try a city name, like "Portland, OR".`);
  // Round to ~1 km: plenty for a forecast, and less precise about where you live.
  return {
    name: [hit.name, hit.admin1].filter(Boolean).join(', '),
    lat: Math.round(hit.latitude * 100) / 100,
    lon: Math.round(hit.longitude * 100) / 100,
  };
}

export async function refresh({ force = false } = {}) {
  const place = db.settings.weatherPlace;
  if (!place) return false;
  const cache = db.weather;
  if (!force && cache && cache.key === `${place.lat},${place.lon}` && Date.now() - cache.fetchedAt < MAX_AGE) return false;
  const params = new URLSearchParams({
    latitude: place.lat, longitude: place.lon, timezone: 'auto', forecast_days: 16,
    hourly: 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m',
    temperature_unit: 'fahrenheit', wind_speed_unit: 'mph',
  });
  const res = await fetch(`${FORECAST}?${params}`);
  if (!res.ok) throw new Error('Could not load the forecast.');
  const h = (await res.json()).hourly;
  const hours = {};
  h.time.forEach((t, i) => {
    hours[t] = [Math.round(h.temperature_2m[i]), h.precipitation_probability[i] ?? 0, h.weather_code[i], Math.round(h.wind_speed_10m[i])];
  });
  db.weather = { key: `${place.lat},${place.lon}`, fetchedAt: Date.now(), hours };
  save();
  return true;
}

// Forecast for the hour a workout starts: { temp, rain, code, wind } or null.
export function at(date, time) {
  const hours = db.weather?.hours;
  if (!hours || !time) return null;
  const hit = hours[`${date}T${time.slice(0, 2)}:00`];
  return hit ? { temp: hit[0], rain: hit[1], code: hit[2], wind: hit[3] } : null;
}

export function icon(code) {
  if (code <= 1) return 'sun';
  if (code <= 3) return 'sun-low';
  if (code === 45 || code === 48) return 'cloud-fog';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'cloud-snow';
  if (code >= 95) return 'cloud-storm';
  if (code >= 51) return 'cloud-rain';
  return 'cloud';
}

export function label(f) {
  return `${f.temp}°${f.rain >= 20 ? ` · ${f.rain}% rain` : ''}${f.wind >= 15 ? ` · ${f.wind} mph wind` : ''}`;
}

// One line per day for the coach, e.g. "48–61°F; rain likely 3p–6p (70%)".
export function daySummary(date) {
  const hours = db.weather?.hours;
  if (!hours) return '';
  const day = [];
  for (let h = 6; h <= 21; h++) {
    const v = hours[`${date}T${String(h).padStart(2, '0')}:00`];
    if (v) day.push({ h, temp: v[0], rain: v[1] });
  }
  if (!day.length) return '';
  const temps = day.map((d) => d.temp);
  const wet = day.filter((d) => d.rain >= 50);
  const fmt = (h) => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;
  const rain = wet.length
    ? `; rain likely ${fmt(wet[0].h)}–${fmt(wet[wet.length - 1].h + 1)} (up to ${Math.max(...wet.map((d) => d.rain))}%)`
    : '; dry';
  return `${Math.min(...temps)}–${Math.max(...temps)}°F${rain}`;
}
