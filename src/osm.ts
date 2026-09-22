import type { LatLon } from "./geo.js";
import { compactTrails, parseTrails, type OverpassResponse, type Trail } from "./trails.js";

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

/** [south, west, north, east] */
export type BBox = [number, number, number, number];

const GRID = 0.1;
/** Expand a box outward to a 0.1° grid so nearby searches share a cache entry. */
export function snapBBox([s, w, n, e]: BBox): BBox {
  const r = (x: number) => Math.round(x * 10) / 10;
  return [r(Math.floor(s / GRID) * GRID), r(Math.floor(w / GRID) * GRID), r(Math.ceil(n / GRID) * GRID), r(Math.ceil(e / GRID) * GRID)];
}

export function trailQuery([s, w, n, e]: BBox): string {
  const bb = `${s},${w},${n},${e}`;
  // Relation geometry is clipped to the box so long-distance routes stay small.
  return `[out:json][timeout:25];
relation["route"~"^(hiking|foot)$"]["name"](${bb});
out geom(${bb});
way["highway"~"^(path|footway|bridleway|steps|cycleway)$"]["name"](${bb});
out geom;
(node["highway"="trailhead"](${bb});node["amenity"="parking"]["access"!~"private|no"](${bb}););
out;
(way["highway"="trailhead"](${bb});way["amenity"="parking"]["access"!~"private|no"](${bb}););
out tags center;`;
}

/**
 * Query Overpass with hedging: start on the first mirror, and each time a mirror
 * fails or stays silent for `hedgeMs`, bring in the next one. First success wins.
 */
export async function fetchTrailData(
  bbox: BBox,
  signal?: AbortSignal,
  perMirrorMs = 25000,
  hedgeMs = 10000,
): Promise<OverpassResponse> {
  const body = "data=" + encodeURIComponent(trailQuery(bbox));
  const done = new AbortController();
  const stop = () => done.abort();
  signal?.addEventListener("abort", stop);
  const attempt = async (url: string): Promise<OverpassResponse> => {
    const res = await fetch(url, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Browsers ignore this; on the server it identifies us to Overpass as they ask.
        "User-Agent": "hike-tracker/0.1 (+https://github.com/tschomay/hike-tracker)",
      },
      signal: AbortSignal.any([done.signal, AbortSignal.timeout(perMirrorMs)]),
    });
    if (!res.ok) throw new Error(`Overpass ${res.status} from ${new URL(url).host}`);
    const json = (await res.json()) as OverpassResponse & { remark?: string };
    // Overpass reports query timeouts as a 200 with a remark and partial data.
    if (json.remark && /runtime error|timed out/i.test(json.remark)) throw new Error(json.remark);
    return json;
  };
  try {
    return await new Promise<OverpassResponse>((ok, fail) => {
      let next = 0, failed = 0, timer: ReturnType<typeof setTimeout> | undefined;
      const resolve = (v: OverpassResponse) => (clearTimeout(timer), ok(v));
      const reject = (e: unknown) => (clearTimeout(timer), fail(e));
      const errors: unknown[] = [];
      const launch = () => {
        if (next >= OVERPASS.length) return;
        const url = OVERPASS[next++];
        clearTimeout(timer);
        timer = setTimeout(launch, hedgeMs);
        attempt(url).then(resolve, (e) => {
          errors.push(e);
          if (++failed === OVERPASS.length || signal?.aborted) reject(signal?.aborted ? e : new Error(errors.map(String).join("; ")));
          else if (next === failed) launch(); // nothing else in flight: move on now
        });
      };
      launch();
    });
  } finally {
    stop();
    signal?.removeEventListener("abort", stop);
  }
}

/** Trails in (roughly) this box: cached server route first, direct Overpass as a fallback. */
export async function findTrails(bbox: BBox, signal?: AbortSignal): Promise<Trail[]> {
  const snapped = snapBBox(bbox);
  const cacheKey = `trail.area.${snapped.join(",")}`;
  const remember = (trails: Trail[]) => {
    try {
      localStorage.setItem(cacheKey, JSON.stringify(trails));
    } catch {} // storage full: fine, it's only an offline convenience
    return trails;
  };
  try {
    const res = await fetch(`/api/trails?bbox=${snapped.join(",")}`, { signal });
    if (res.ok) return remember(((await res.json()) as { trails: Trail[] }).trails);
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  try {
    const c: LatLon = [(snapped[0] + snapped[2]) / 2, (snapped[1] + snapped[3]) / 2];
    return remember(compactTrails(parseTrails(await fetchTrailData(snapped, signal), c)));
  } catch (e) {
    const saved = localStorage.getItem(cacheKey);
    if (saved && !signal?.aborted) return JSON.parse(saved);
    throw e;
  }
}

export async function geocode(q: string): Promise<{ name: string; at: LatLon; bbox?: BBox } | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const [hit] = await res.json();
  if (!hit) return null;
  const b = hit.boundingbox?.map(Number);
  return {
    name: hit.display_name,
    at: [Number(hit.lat), Number(hit.lon)],
    bbox: b ? [b[0], b[2], b[1], b[3]] : undefined,
  };
}

/** Total climb in meters along a line, from Open-Meteo's DEM (max 100 samples). */
export async function elevationGain(line: LatLon[]): Promise<number | null> {
  if (line.length < 2) return null;
  const n = Math.min(100, line.length);
  const pts = Array.from({ length: n }, (_, i) => line[Math.round((i * (line.length - 1)) / (n - 1))]);
  const lat = pts.map((p) => p[0].toFixed(5)).join(",");
  const lon = pts.map((p) => p[1].toFixed(5)).join(",");
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
    if (!res.ok) return null;
    const { elevation } = (await res.json()) as { elevation: number[] };
    let gain = 0;
    for (let i = 1; i < elevation.length; i++) gain += Math.max(0, elevation[i] - elevation[i - 1]);
    return gain;
  } catch {
    return null;
  }
}

export function directionsUrl([lat, lon]: LatLon): string {
  const apple = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent) && "ontouchend" in document;
  return apple
    ? `https://maps.apple.com/?daddr=${lat},${lon}&dirflg=d`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;
}
