import { describe, it, expect } from "vitest";
import { haversine, nearestOnLines, compass, fmtDuration, type LatLon } from "../src/geo";
import { stitch, parseTrails, type OverpassResponse } from "../src/trails";
import { newTrack, update } from "../src/tracker";

// ~111 m per 0.001° latitude
const line = (lat0: number, n: number, lon = -105): LatLon[] =>
  Array.from({ length: n }, (_, i) => [lat0 + i * 0.001, lon]);
const geom = (pts: LatLon[]) => pts.map(([lat, lon]) => ({ lat, lon }));

describe("geo", () => {
  it("haversine ~111m per millidegree latitude", () => {
    expect(haversine([40, -105], [40.001, -105])).toBeCloseTo(111.2, 0);
  });
  it("nearestOnLines finds perpendicular distance", () => {
    const r = nearestOnLines([40.0005, -104.999], [line(40, 3)]);
    expect(r.d).toBeGreaterThan(80);
    expect(r.d).toBeLessThan(90);
    expect(r.at[1]).toBeCloseTo(-105, 6);
  });
  it("compass", () => {
    expect(compass([40, -105], [40.01, -105])).toBe("N");
    expect(compass([40, -105], [40, -104.99])).toBe("E");
  });
  it("fmtDuration", () => {
    expect(fmtDuration(65_000)).toBe("1:05");
    expect(fmtDuration(3_725_000)).toBe("1:02:05");
  });
});

describe("stitch", () => {
  it("joins reversed and out-of-order segments into one chain", () => {
    const full = line(40, 10);
    const parts = [full.slice(4, 7), full.slice(0, 5).reverse(), full.slice(6)];
    const out = stitch(parts);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(10);
  });
  it("keeps disconnected pieces separate", () => {
    expect(stitch([line(40, 3), line(41, 3)])).toHaveLength(2);
  });
});

describe("parseTrails", () => {
  const data: OverpassResponse = {
    elements: [
      // Route relation made of two ways; its ways also come back as named paths.
      {
        type: "relation", id: 1, tags: { route: "hiking", name: "Ridge Loop" },
        members: [
          { type: "way", ref: 10, role: "", geometry: geom(line(40, 6)) },
          { type: "way", ref: 11, role: "", geometry: [...geom(line(40.005, 6)), null, ...geom(line(40.02, 3))] },
        ],
      },
      { type: "way", id: 10, nodes: [1, 2], tags: { highway: "path", name: "Ridge Loop" }, geometry: geom(line(40, 6)) },
      // Two touching ways with the same name -> one trail.
      { type: "way", id: 20, nodes: [100, 101, 102], tags: { highway: "path", name: "Creek Trail" }, geometry: geom(line(40, 6, -104.9)) },
      { type: "way", id: 21, nodes: [102, 103], tags: { highway: "path", name: "Creek Trail" }, geometry: geom(line(40.005, 6, -104.9)) },
      // Same name, not touching, but only ~110 m apart -> merged into Creek Trail.
      { type: "way", id: 22, nodes: [104, 105], tags: { highway: "path", name: "Creek Trail" }, geometry: geom(line(40.011, 3, -104.9)) },
      // Same name far away -> separate trail. Paved greenway -> dropped.
      { type: "way", id: 23, nodes: [106, 107], tags: { highway: "path", name: "Creek Trail" }, geometry: geom(line(40.1, 10, -104.9)) },
      { type: "way", id: 24, nodes: [108, 109], tags: { highway: "path", surface: "asphalt", name: "Greenway" }, geometry: geom(line(40, 20, -104.6)) },
      // Too short, and a sidewalk: both dropped.
      { type: "way", id: 30, nodes: [200, 201], tags: { highway: "path", name: "Stub" }, geometry: geom(line(40, 2, -104.8)) },
      { type: "way", id: 31, nodes: [300, 301], tags: { highway: "footway", footway: "sidewalk", name: "Main St" }, geometry: geom(line(40, 20, -104.7)) },
      { type: "node", id: 500, lat: 40.0001, lon: -104.9002, tags: { highway: "trailhead" } },
      { type: "way", id: 600, center: { lat: 40.0101, lon: -105.0005 }, tags: { amenity: "parking" } },
    ],
  };
  const trails = parseTrails(data, [40, -104.9]);

  it("builds one trail per route and per connected same-named path group", () => {
    expect(trails.map((t) => t.name).sort()).toEqual(["Creek Trail", "Creek Trail", "Ridge Loop"]);
  });
  it("stitches grouped ways and measures length", () => {
    const creek = trails.find((t) => t.name === "Creek Trail")!;
    expect(creek.lines).toHaveLength(2); // connected piece + the piece across the gap
    expect(creek.lengthM).toBeCloseTo(1112 + 222, -1);
  });
  it("splits clipped relation geometry at nulls", () => {
    const ridge = trails.find((t) => t.name === "Ridge Loop")!;
    expect(ridge.lines).toHaveLength(2);
  });
  it("prefers mapped trailheads, then parking", () => {
    expect(trails.find((t) => t.name === "Creek Trail")!.startKind).toBe("trailhead");
    expect(trails.find((t) => t.name === "Ridge Loop")!.startKind).toBe("parking");
  });
  it("sorts by distance to the search center", () => {
    expect(trails[0].name).toBe("Creek Trail");
  });
});

describe("tracker", () => {
  const trail = [line(40, 20)];
  const fix = (lat: number, lon = -105, acc = 5, t = 0) => ({ at: [lat, lon] as LatLon, acc, t });

  it("accumulates distance and ignores jitter and inaccurate fixes", () => {
    let t = newTrack("x", 0);
    for (const f of [fix(40), fix(40.00002), fix(40.001), fix(40.05, -105, 200), fix(40.002)]) t = update(t, f, trail).track;
    expect(t.distanceM).toBeCloseTo(222, -1);
  });
  it("flags leaving the trail only after consecutive far fixes, then clears", () => {
    let t = newTrack("x", 0);
    const events: (string | null)[] = [];
    for (const f of [fix(40.001), fix(40.002, -104.999), fix(40.003), fix(40.004, -104.999), fix(40.005, -104.999), fix(40.006), fix(40.007)]) {
      const r = update(t, f, trail);
      t = r.track;
      events.push(r.event);
    }
    expect(events).toEqual([null, null, null, null, "left-trail", null, "back-on-trail"]);
  });
});

describe("simplify + snap", async () => {
  const { simplify } = await import("../src/trails");
  const { snapBBox } = await import("../src/osm");
  it("drops collinear points but keeps corners", () => {
    const l: LatLon[] = [[40, -105], [40.001, -105], [40.002, -105], [40.002, -104.998]];
    expect(simplify(l, 2)).toEqual([[40, -105], [40.002, -105], [40.002, -104.998]]);
  });
  it("snaps outward to a 0.1° grid", () => {
    expect(snapBBox([39.95, -105.33, 40.07, -105.21])).toEqual([39.9, -105.4, 40.1, -105.2]);
    // Already on the grid: unchanged (float division would push 42.8 down to 42.7).
    expect(snapBBox([42.8, -72.2, 42.9, -72])).toEqual([42.8, -72.2, 42.9, -72]);
    expect(snapBBox([-33.9, 151.1, -33.8, 151.3])).toEqual([-33.9, 151.1, -33.8, 151.3]);
  });
});

describe("fetchTrailData hedging", async () => {
  const { fetchTrailData } = await import("../src/osm");
  const { vi } = await import("vitest");
  it("falls through failing mirrors and returns the first success", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(new URL(url).host);
      if (calls.length === 1) return new Response("busy", { status: 504 });
      return Response.json({ elements: [] });
    });
    await expect(fetchTrailData([40, -105, 40.1, -104.9], undefined, 1000, 500)).resolves.toEqual({ elements: [] });
    expect(calls).toHaveLength(2);
    vi.unstubAllGlobals();
  });
  it("hedges to the next mirror when the first is slow", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      calls.push(new URL(url).host);
      if (calls.length === 1)
        return new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
      return Promise.resolve(Response.json({ elements: [1] }));
    });
    await expect(fetchTrailData([40, -105, 40.1, -104.9], undefined, 5000, 50)).resolves.toEqual({ elements: [1] });
    expect(calls).toHaveLength(2);
    vi.unstubAllGlobals();
  });
  it("reports failure when every mirror fails", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 429 }));
    await expect(fetchTrailData([40, -105, 40.1, -104.9], undefined, 1000, 500)).rejects.toThrow(/429/);
    vi.unstubAllGlobals();
  });
});
