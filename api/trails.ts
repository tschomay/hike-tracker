// Server-side trail lookup. Queries Overpass, parses into compact trails, and
// caches per grid-snapped box: in Vercel's runtime cache (so an area only has
// to come from Overpass once a week, and a stale copy covers Overpass outages)
// and at the CDN edge.
import { getCache } from "@vercel/functions";
import { fetchTrailData, snapBBox, type BBox } from "../src/osm.js";
import { parseTrails, compactTrails, type Trail } from "../src/trails.js";

const FRESH_MS = 7 * 24 * 3600 * 1000;
const KEEP_S = 30 * 24 * 3600;
// Bump when parsing changes so old cached results are not served.
const VERSION = "v2";

type Entry = { at: number; trails: Trail[] };

export async function GET(request: Request): Promise<Response> {
  const raw = new URL(request.url).searchParams.get("bbox")?.split(",").map(Number);
  if (!raw || raw.length !== 4 || raw.some((n) => !Number.isFinite(n))) {
    return Response.json({ error: "bbox=s,w,n,e required" }, { status: 400 });
  }
  const bbox = snapBBox(raw as BBox);
  if (bbox[2] - bbox[0] > 0.41 || bbox[3] - bbox[1] > 0.41) {
    return Response.json({ error: "area too large" }, { status: 400 });
  }
  const key = `trails:${VERSION}:${bbox.join(",")}`;
  const cache = getCache();
  const hit = (await cache.get(key).catch(() => null)) as Entry | null;
  const reply = (e: Entry, source: string) =>
    Response.json(
      { bbox, trails: e.trails },
      {
        headers: {
          "Cache-Control": "public, max-age=86400",
          "Vercel-CDN-Cache-Control": "public, max-age=604800, stale-while-revalidate=2592000",
          "X-Trails-Source": source,
        },
      },
    );
  if (hit && Date.now() - hit.at < FRESH_MS) return reply(hit, "cache");

  try {
    const data = await fetchTrailData(bbox, undefined, 40000, 12000);
    const entry = { at: Date.now(), trails: compactTrails(parseTrails(data, [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2])) };
    await cache.set(key, entry, { ttl: KEEP_S }).catch(() => {});
    return reply(entry, "overpass");
  } catch (e) {
    if (hit) return reply(hit, "stale");
    return Response.json({ error: String(e) }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
