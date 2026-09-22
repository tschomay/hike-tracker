// Server-side trail lookup: queries Overpass, parses into compact trails, and
// lets Vercel's CDN cache the result per grid-snapped box so repeat searches
// of an area are instant and don't touch Overpass at all.
import { fetchTrailData, snapBBox, type BBox } from "../src/osm";
import { parseTrails, compactTrails } from "../src/trails";

export async function GET(request: Request): Promise<Response> {
  const raw = new URL(request.url).searchParams.get("bbox")?.split(",").map(Number);
  if (!raw || raw.length !== 4 || raw.some((n) => !Number.isFinite(n))) {
    return Response.json({ error: "bbox=s,w,n,e required" }, { status: 400 });
  }
  const bbox = snapBBox(raw as BBox);
  if (bbox[2] - bbox[0] > 0.41 || bbox[3] - bbox[1] > 0.41) {
    return Response.json({ error: "area too large" }, { status: 400 });
  }
  try {
    const data = await fetchTrailData(bbox, undefined, 40000, 12000);
    const trails = compactTrails(parseTrails(data, [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]));
    return Response.json(
      { bbox, trails },
      { headers: { "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000" } },
    );
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
