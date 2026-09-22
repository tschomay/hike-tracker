// Fetches real Overpass data for a few well-known hiking areas and summarizes
// what the trail parser makes of it. Run in any environment with internet:
//   npx esbuild scripts/eval-areas.ts --bundle --platform=node --outfile=/tmp/eval.mjs --format=esm && node /tmp/eval.mjs
import { fetchTrailData, type BBox } from "../src/osm";
import { parseTrails, compactTrails } from "../src/trails";
import { fmtMiles } from "../src/geo";

const areas: Record<string, BBox> = {
  "Boulder, CO": [39.9, -105.4, 40.06, -105.24],
  "Yosemite Valley": [37.68, -119.7, 37.78, -119.5],
  "Great Smokies (Gatlinburg)": [35.6, -83.6, 35.72, -83.4],
  "Seattle (Issaquah Alps)": [47.45, -122.1, 47.57, -121.9],
  "Suburban Ohio (Columbus)": [39.9, -83.1, 40.02, -82.9],
};

for (const [name, bbox] of Object.entries(areas)) {
  const t0 = Date.now();
  let data;
  try { data = await fetchTrailData(bbox); } catch (e) { console.log(name, "FAILED", String(e).slice(0, 120)); continue; }
  const text = JSON.stringify(data);
  const c: [number, number] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  const t1 = Date.now();
  const trails = parseTrails(data, c);
  const kinds = trails.reduce((m, t) => ((m[t.startKind] = (m[t.startKind] ?? 0) + 1), m), {} as Record<string, number>);
  const compact = JSON.stringify(compactTrails(trails)).length;
  console.log(`\n## ${name}: ${(text.length / 1e6).toFixed(2)} MB raw, ${(compact / 1e3).toFixed(0)} KB compact, fetch ${t1 - t0} ms, parse ${Date.now() - t1} ms, ${data.elements.length} elements -> ${trails.length} trails`, kinds);
  const pieces = trails.filter((t) => t.lines.length > 1).length;
  console.log(`   multi-piece trails: ${pieces}`);
  for (const t of trails.slice(0, 6)) console.log(`   ${t.id.padEnd(12)} ${t.name.slice(0, 40).padEnd(40)} ${fmtMiles(t.lengthM).padStart(7)} pieces=${t.lines.length} ${t.loop ? "loop" : ""} start=${t.startKind}`);
  await new Promise((r) => setTimeout(r, 3000));
}
