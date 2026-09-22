# Trail

A deliberately small hiking app. It does three things:

1. **Find a hike.** Opens on your location and lists nearby named trails with distance, loop/out-and-back, and elevation gain. You can also search a place.
2. **Drive to the trailhead.** One tap opens Apple Maps (iOS/macOS) or Google Maps with directions to the start.
3. **Track the hike.** Shows distance and time. If you leave the trail it buzzes/beeps and tells you how far and which direction to get back.

That's it. No accounts, feeds, or photos.

## Where the data comes from

- **Trails:** [OpenStreetMap](https://www.openstreetmap.org), via the public [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API). AllTrails builds its own trail database from OSM too ([their write-up](https://support.alltrails.com/hc/en-us/articles/360019246411-OSM-derivative-database-derivation-methodology)).
  - `api/trails` (Vercel function) snaps a search to a 0.1° grid and queries Overpass. It tries mirrors, bringing in the next one if the current one fails or is silent for 12 s. It parses the result into compact trails (~10x smaller than raw).
  - Each area is kept in Vercel's runtime cache for 30 days and counts as fresh for 7. If Overpass is down, the stale copy is served.
  - If the function fails, the browser queries Overpass directly, then falls back to the last result it saved for that area.
  - Public Overpass is often slow, so the **first** search of an area can take up to a minute. Repeat searches are instant.
  A "trail" is either a named `route=hiking|foot` relation, or a group of connected paths that share a name.
- **Trailhead:** a mapped `highway=trailhead` within 400 m of the trail. If there isn't one, the nearest public parking within 1.5 km. Otherwise, the end of the trail closest to where you searched.
- **Elevation gain:** [Open-Meteo elevation API](https://open-meteo.com/en/docs/elevation-api).
- **Map tiles:** [OpenTopoMap](https://opentopomap.org). Any tiles you've viewed are cached, and opening a trail pre-caches its area at zoom 13–15, so the map still works without signal.
- **Search:** [Nominatim](https://nominatim.org).

None of these need API keys.

## How tracking works

- GPS fixes with accuracy worse than 50 m are ignored. Distance only counts moves of 8 m or more, to filter out jitter.
- You're **off trail** after 2 fixes in a row more than 40 m from the trail line (plus up to 25 m of accuracy slack). You're back on after 2 fixes in a row within 30 m.
- The screen stays awake while you track (Wake Lock API). If you reload the page or it gets killed, the hike picks up where it left off.
- **Known limitation:** browsers pause GPS when the screen is off or the app is in the background. Keep the app open while you hike. Background tracking would need a native app wrapper.

## Develop

```sh
npm install
npm run dev     # local server
npm test        # unit tests (geometry, trail stitching, tracker)
npm run build   # typecheck + production build to dist/
```

`npm run dev` also serves `api/` locally. `scripts/eval-areas.ts` runs the trail parser against live Overpass data for a few real areas. It's a sanity check for data quality and needs internet access.

## Deploy

Vercel project `hike-tracker` (static Vite build). The repo is connected to it, so every push deploys.
