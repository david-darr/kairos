// Pure usage geometry and formatting, shared by the panel and Settings.
export function duration(seconds) {
  if (!Number.isFinite(seconds)) return 'Unknown';
  const s = Math.max(0, seconds);
  if (s < 1) return `${Math.round(s * 1000)}ms`;
  if (s < 60) return `${Number(s.toFixed(1))}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
}
export function cost(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Unknown';
  return value > 0 && value < .001 ? '<$0.001' : `$${value.toFixed(3)}`;
}
export const contextTone = percent => percent >= 80 ? 'danger' : percent >= 50 ? 'warn' : 'quiet';
export const meterTone = percent => percent > 90 ? 'danger' : percent >= 70 ? 'warn' : 'success';
export function geometry(start, seconds, origin, span) {
  const left = Math.min(100, Math.max(0, (start - origin) / Math.max(span, .001) * 100));
  return { left, width: Math.min(100 - left, Math.max(.5, seconds / Math.max(span, .001) * 100)) };
}
export function ticks(seconds) {
  const raw = Math.max(.001, seconds) / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(n => n * power).find(n => n >= raw);
  return Array.from({ length: Math.ceil(seconds / step) + 1 }, (_, i) => i * step);
}
export function periodRange(period, now = new Date()) {
  const end = new Date(now), start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  if (period === 'month') start.setDate(1);
  if (period === 'last-month') { start.setDate(1); end.setTime(start.getTime()); start.setMonth(start.getMonth() - 1); }
  if (period === '30-days') start.setDate(start.getDate() - 29);
  return { from: start.toISOString(), to: end.toISOString() };
}
