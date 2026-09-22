import { haversine, lineLength, distToLines, type LatLon } from "./geo";

/** A hike the user can pick: one named trail, as one or more polylines. */
export interface Trail {
  id: string;
  name: string;
  lines: LatLon[][];
  lengthM: number;
  /** Where to drive to and start walking. */
  start: LatLon;
  startKind: "trailhead" | "parking" | "trail end";
  loop: boolean;
}

type Pt = { lat: number; lon: number } | null;
interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  nodes?: number[];
  geometry?: Pt[];
  members?: { type: string; ref: number; role: string; geometry?: Pt[] }[];
  tags?: Record<string, string>;
}
export interface OverpassResponse {
  elements: OsmElement[];
}

const MIN_PATH_M = 800;
const MIN_ROUTE_M = 300;

/** Split a possibly-clipped Overpass geometry (nulls = outside bbox) into runs. */
function toRuns(geom: Pt[] | undefined): LatLon[][] {
  const runs: LatLon[][] = [];
  let cur: LatLon[] = [];
  for (const p of geom ?? []) {
    if (p) cur.push([p.lat, p.lon]);
    else if (cur.length) (runs.push(cur), (cur = []));
  }
  if (cur.length) runs.push(cur);
  return runs.filter((r) => r.length > 1);
}

const key = (p: LatLon) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;

/** Join polylines that share endpoints into as few continuous chains as possible. */
export function stitch(lines: LatLon[][]): LatLon[][] {
  const ends = new Map<string, number[]>();
  lines.forEach((l, i) => {
    for (const k of [key(l[0]), key(l[l.length - 1])]) {
      const arr = ends.get(k) ?? [];
      arr.push(i);
      ends.set(k, arr);
    }
  });
  const used = new Array(lines.length).fill(false);
  const takeAt = (p: LatLon): LatLon[] | null => {
    for (const i of ends.get(key(p)) ?? []) {
      if (used[i]) continue;
      used[i] = true;
      const l = lines[i];
      return key(l[0]) === key(p) ? l : [...l].reverse();
    }
    return null;
  };
  // Start chains at dead ends first so linear trails come out as one piece.
  const deg = (i: number) => {
    const l = lines[i];
    return Math.min(ends.get(key(l[0]))!.length, ends.get(key(l[l.length - 1]))!.length);
  };
  const order = lines.map((_, i) => i).sort((a, b) => deg(a) - deg(b) || a - b);
  const chains: LatLon[][] = [];
  for (const i of order) {
    if (used[i]) continue;
    used[i] = true;
    let chain = [...lines[i]];
    for (let next; (next = takeAt(chain[chain.length - 1])); ) chain = chain.concat(next.slice(1));
    for (let prev; (prev = takeAt(chain[0])); ) chain = [...prev].reverse().slice(0, -1).concat(chain);
    chains.push(chain);
  }
  return chains;
}

function isHikeablePath(t: Record<string, string>): boolean {
  if (!t.name) return false;
  if (t.access === "private" || t.access === "no" || t.foot === "no") return false;
  if (t.footway === "sidewalk" || t.footway === "crossing") return false;
  if (t.highway === "cycleway" && t.foot !== "designated") return false;
  return true;
}

/** Turn a raw Overpass response into a list of distinct, named trails. */
export function parseTrails(data: OverpassResponse, center: LatLon): Trail[] {
  const trailheads: LatLon[] = [];
  const parking: LatLon[] = [];
  const relations: OsmElement[] = [];
  const ways: OsmElement[] = [];

  for (const e of data.elements) {
    const t = e.tags ?? {};
    if (t.highway === "trailhead" || t.amenity === "trailhead") {
      const c = e.lat != null ? [e.lat, e.lon!] : e.center ? [e.center.lat, e.center.lon] : null;
      if (c) trailheads.push(c as LatLon);
    } else if (t.amenity === "parking") {
      const c = e.lat != null ? [e.lat, e.lon!] : e.center ? [e.center.lat, e.center.lon] : null;
      if (c) parking.push(c as LatLon);
    } else if (e.type === "relation" && t.name) relations.push(e);
    else if (e.type === "way" && isHikeablePath(t)) ways.push(e);
  }

  const trails: Trail[] = [];
  const inRelation = new Set<number>();

  for (const r of relations) {
    const runs: LatLon[][] = [];
    for (const m of r.members ?? []) {
      if (m.type !== "way") continue;
      inRelation.add(m.ref);
      runs.push(...toRuns(m.geometry));
    }
    if (!runs.length) continue;
    const lines = stitch(runs);
    const lengthM = lines.reduce((s, l) => s + lineLength(l), 0);
    if (lengthM < MIN_ROUTE_M) continue;
    trails.push(finish(`r${r.id}`, r.tags!.name, lines, lengthM));
  }

  // Group same-named ways that touch (share any node) into one trail each.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  const freeWays = ways.filter((w) => !inRelation.has(w.id));
  const nodeOwner = new Map<string, number>();
  for (const w of freeWays) {
    parent.set(w.id, w.id);
    const name = w.tags!.name.toLowerCase();
    for (const n of w.nodes ?? []) {
      const k = `${name}|${n}`;
      const other = nodeOwner.get(k);
      if (other == null) nodeOwner.set(k, w.id);
      else parent.set(find(w.id), find(other));
    }
  }
  const groups = new Map<number, OsmElement[]>();
  for (const w of freeWays) {
    const root = find(w.id);
    groups.set(root, [...(groups.get(root) ?? []), w]);
  }
  for (const [root, members] of groups) {
    const lines = stitch(members.flatMap((w) => toRuns(w.geometry)));
    if (!lines.length) continue;
    const lengthM = lines.reduce((s, l) => s + lineLength(l), 0);
    if (lengthM < MIN_PATH_M) continue;
    trails.push(finish(`w${root}`, members[0].tags!.name, lines, lengthM));
  }

  function finish(id: string, name: string, lines: LatLon[][], lengthM: number): Trail {
    const longest = lines.reduce((a, b) => (lineLength(b) > lineLength(a) ? b : a));
    const a = longest[0], b = longest[longest.length - 1];
    const loop = lines.length === 1 && haversine(a, b) < 50;
    const near = (pts: LatLon[], maxM: number) => {
      let best: LatLon | null = null, bestD = maxM;
      for (const p of pts) {
        const d = distToLines(p, lines);
        if (d < bestD) (best = p), (bestD = d);
      }
      return best;
    };
    const th = near(trailheads, 400);
    if (th) return { id, name, lines, lengthM, start: th, startKind: "trailhead", loop };
    const pk = near(parking, 300);
    if (pk) return { id, name, lines, lengthM, start: pk, startKind: "parking", loop };
    // No mapped trailhead: use whichever end of the main line is closer to the search center.
    const start = haversine(a, center) <= haversine(b, center) ? a : b;
    return { id, name, lines, lengthM, start, startKind: "trail end", loop };
  }

  return trails.sort((x, y) => haversine(x.start, center) - haversine(y.start, center));
}

/** Douglas-Peucker: drop points that sit within tolM of the simplified line. */
export function simplify(line: LatLon[], tolM: number): LatLon[] {
  if (line.length < 3) return line;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let worst = -1, worstD = tolM;
    for (let k = i + 1; k < j; k++) {
      const d = distToLines(line[k], [[line[i], line[j]]]);
      if (d > worstD) (worst = k), (worstD = d);
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return line.filter((_, k) => keep[k]);
}

/** Shrink the payload sent to phones: ~2 m simplification, ~1 m coordinate precision. */
export function compactTrails(trails: Trail[]): Trail[] {
  const r = (p: LatLon): LatLon => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
  return trails.map((t) => ({
    ...t,
    lengthM: Math.round(t.lengthM),
    start: r(t.start),
    lines: t.lines.map((l) => simplify(l, 2).map(r)),
  }));
}
