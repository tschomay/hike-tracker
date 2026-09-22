import type { LatLon } from "./geo";
import type { OverpassResponse } from "./trails";

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

/** [south, west, north, east] */
export type BBox = [number, number, number, number];

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

export async function fetchTrailData(bbox: BBox, signal?: AbortSignal): Promise<OverpassResponse> {
  const body = "data=" + encodeURIComponent(trailQuery(bbox));
  let lastErr: unknown;
  for (const url of OVERPASS) {
    try {
      // Give each mirror a fair shot, then move on to the next.
      const timeout = AbortSignal.timeout(20000);
      const res = await fetch(url, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return await res.json();
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
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
