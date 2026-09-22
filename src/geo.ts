export type LatLon = [number, number];

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in meters. */
export function haversine(a: LatLon, b: LatLon): number {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lineLength(line: LatLon[]): number {
  let d = 0;
  for (let i = 1; i < line.length; i++) d += haversine(line[i - 1], line[i]);
  return d;
}

/**
 * Closest point on segment ab to p, using a local equirectangular projection
 * (accurate to well under a meter at trail scales).
 */
function closestOnSegment(p: LatLon, a: LatLon, b: LatLon): { d: number; at: LatLon } {
  const k = Math.cos(rad(p[0]));
  const ax = (a[1] - p[1]) * k, ay = a[0] - p[0];
  const dx = (b[1] - a[1]) * k, dy = b[0] - a[0];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const x = ax + t * dx, y = ay + t * dy;
  return { d: rad(Math.sqrt(x * x + y * y)) * R, at: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
}

/** Closest point on any of the lines to p, and its distance in meters. */
export function nearestOnLines(p: LatLon, lines: LatLon[][]): { d: number; at: LatLon } {
  let best = { d: Infinity, at: p };
  for (const line of lines) {
    if (line.length === 1) {
      const d = haversine(p, line[0]);
      if (d < best.d) best = { d, at: line[0] };
    }
    for (let i = 1; i < line.length; i++) {
      const c = closestOnSegment(p, line[i - 1], line[i]);
      if (c.d < best.d) best = c;
    }
  }
  return best;
}

export const distToLines = (p: LatLon, lines: LatLon[][]) => nearestOnLines(p, lines).d;

/** Compass direction from a to b, e.g. "NE". */
export function compass(a: LatLon, b: LatLon): string {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x =
    Math.cos(rad(a[0])) * Math.sin(rad(b[0])) -
    Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
}

export const M_PER_MI = 1609.344;
export const FT_PER_M = 3.28084;

export function fmtMiles(m: number): string {
  const mi = m / M_PER_MI;
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
