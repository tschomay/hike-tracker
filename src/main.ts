import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import { compass, fmtDuration, fmtMiles, FT_PER_M, lineLength, type LatLon } from "./geo.js";
import { directionsUrl, elevationGain, findTrails, geocode, type BBox } from "./osm.js";
import type { Trail } from "./trails.js";
import { newTrack, update, type Track } from "./tracker.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sheet = $("sheet"), banner = $("banner"), here = $("here");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- map ----------
const map = L.map("map", { zoomControl: false, attributionControl: true }).setView([39.5, -98.35], 4);
L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
  maxZoom: 17,
  subdomains: "abc",
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, © <a href="https://opentopomap.org">OpenTopoMap</a>',
}).addTo(map);
const trailLayer = L.layerGroup().addTo(map);
const trackLine = L.polyline([], { color: "#d9480f", weight: 4 }).addTo(map);
const me = L.circleMarker([0, 0], { radius: 8, color: "#fff", weight: 3, fillColor: "#1c7ed6", fillOpacity: 1 });
let meShown = false;
const toLL = (p: LatLon) => L.latLng(p[0], p[1]);

// ---------- state ----------
type View =
  | { kind: "list" }
  | { kind: "detail"; trail: Trail; gainM?: number | null }
  | { kind: "tracking"; trail: Trail; track: Track }
  | { kind: "done"; trail: Trail; track: Track; endedAt: number };
let view: View = { kind: "list" };
let trails: Trail[] = [];
let status = "";
let myPos: LatLon | null = null;
let searchedCenter: L.LatLng | null = null;
let loading: AbortController | null = null;

const ACTIVE_KEY = "trail.active";
const save = () => {
  try {
    if (view.kind === "tracking") localStorage.setItem(ACTIVE_KEY, JSON.stringify({ trail: view.trail, track: view.track }));
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {}
};

// ---------- trail search ----------
async function searchHere() {
  here.hidden = true;
  const c = map.getCenter();
  // Keep queries to a reasonable box (~20 km) no matter how far out the map is zoomed.
  const b = map.getBounds();
  const hs = Math.min((b.getNorth() - b.getSouth()) / 2, 0.08);
  const hw = Math.min((b.getEast() - b.getWest()) / 2, 0.1);
  const bbox: BBox = [c.lat - hs, c.lng - hw, c.lat + hs, c.lng + hw];
  loading?.abort();
  loading = new AbortController();
  status = "Finding hikes…";
  trails = [];
  view = { kind: "list" };
  render();
  try {
    trails = (await findTrails(bbox, loading.signal)).sort(
      (a, b) => c.distanceTo(toLL(a.start)) - c.distanceTo(toLL(b.start)),
    );
    searchedCenter = c;
    status = trails.length ? "" : "No mapped hikes here. Try moving the map.";
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    status = "Couldn't reach the trail database. Try again.";
  }
  render();
}

function drawTrails() {
  trailLayer.clearLayers();
  const selected = view.kind === "list" ? null : view.trail;
  const shown = selected ? [selected] : trails;
  for (const t of shown) {
    const line = L.polyline(t.lines.map((l) => l.map(toLL)), {
      color: selected ? "#c2255c" : "#2b8a3e",
      weight: selected ? 6 : 4,
      opacity: 0.9,
    }).addTo(trailLayer);
    if (!selected) line.on("click", () => openTrail(t));
    else if (view.kind !== "tracking" && view.kind !== "done")
      L.circleMarker(toLL(t.start), { radius: 7, color: "#fff", weight: 2, fillColor: "#212529", fillOpacity: 1 })
        .bindTooltip("Start", { permanent: false })
        .addTo(trailLayer);
  }
}

async function openTrail(t: Trail) {
  view = { kind: "detail", trail: t };
  render();
  map.fitBounds(L.latLngBounds(t.lines.flat().map(toLL)).extend(toLL(t.start)), { paddingTopLeft: [30, 80], paddingBottomRight: [30, sheet.offsetHeight + 20] });
  prefetchTiles(t);
  const main = t.lines.reduce((a, b) => (lineLength(b) > lineLength(a) ? b : a));
  const gainM = await elevationGain(main);
  if (view.kind === "detail" && view.trail === t) {
    view = { ...view, gainM };
    render();
  }
}

/** Warm the service worker's tile cache along the trail so the map works without signal. */
function prefetchTiles(t: Trail) {
  const b = L.latLngBounds(t.lines.flat().map(toLL)).pad(0.1);
  const urls: string[] = [];
  for (let z = 13; z <= 15; z++) {
    const nw = map.project(b.getNorthWest(), z).divideBy(256).floor();
    const se = map.project(b.getSouthEast(), z).divideBy(256).floor();
    for (let x = nw.x; x <= se.x; x++)
      for (let y = nw.y; y <= se.y; y++) urls.push(`https://${"abc"[(x + y) % 3]}.tile.opentopomap.org/${z}/${x}/${y}.png`);
  }
  if (urls.length > 300) return;
  urls.forEach((u, i) => setTimeout(() => fetch(u, { mode: "no-cors" }).catch(() => {}), i * 50));
}

// ---------- tracking ----------
let watchId: number | null = null;
let wakeLock: { release(): Promise<void> } | null = null;
let audio: AudioContext | null = null;
let ticker: number | undefined;

function beep() {
  navigator.vibrate?.([400, 150, 400, 150, 400]);
  if (!audio) return;
  const o = audio.createOscillator(), g = audio.createGain();
  o.frequency.value = 880;
  g.gain.setValueAtTime(0.4, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.8);
  o.connect(g).connect(audio.destination);
  o.start();
  o.stop(audio.currentTime + 0.8);
}

async function keepAwake() {
  try {
    wakeLock = await (navigator as any).wakeLock?.request("screen");
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && view.kind === "tracking") keepAwake();
});

function startTracking(trail: Trail, track = newTrack(trail.id)) {
  view = { kind: "tracking", trail, track };
  try {
    audio ??= new AudioContext();
  } catch {}
  keepAwake();
  trackLine.setLatLngs(track.points.map(toLL));
  ticker = window.setInterval(renderStats, 1000);
  save();
  render();
  follow = true;
}

function stopTracking() {
  if (view.kind !== "tracking") return;
  view = { kind: "done", trail: view.trail, track: view.track, endedAt: Date.now() };
  clearInterval(ticker);
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  banner.hidden = true;
  save();
  render();
}

let follow = true;
map.on("dragstart", () => (follow = false));
map.on("moveend", () => {
  const moved = !searchedCenter || map.getCenter().distanceTo(searchedCenter) > 1500;
  here.hidden = !(view.kind === "list" && moved && map.getZoom() >= 10);
});

function onFix(pos: GeolocationPosition) {
  myPos = [pos.coords.latitude, pos.coords.longitude];
  me.setLatLng(toLL(myPos));
  if (!meShown) (me.addTo(map), (meShown = true));
  if (view.kind !== "tracking") return;
  const r = update(view.track, { at: myPos, acc: pos.coords.accuracy, t: pos.timestamp }, view.trail.lines);
  view.track = r.track;
  trackLine.setLatLngs(r.track.points.map(toLL));
  if (r.event === "left-trail") beep();
  if (r.track.offTrail) {
    banner.hidden = false;
    banner.textContent = `Off trail — ${Math.round(r.toTrail.d * FT_PER_M)} ft ${compass(myPos, r.toTrail.at)} to get back`;
  } else banner.hidden = true;
  if (follow) map.panTo(toLL(myPos), { animate: true });
  save();
  renderStats();
}

function startWatching() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(onFix, (e) => {
    if (e.code === e.PERMISSION_DENIED) {
      status = "Location is off. Search a place to find hikes.";
      render();
    }
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}

// ---------- rendering ----------
function renderStats() {
  if (view.kind !== "tracking" && view.kind !== "done") return;
  const end = view.kind === "done" ? view.endedAt : Date.now();
  const d = sheet.querySelector("#dist"), t = sheet.querySelector("#time");
  if (d) d.textContent = fmtMiles(view.track.distanceM);
  if (t) t.textContent = fmtDuration(end - view.track.startedAt);
}

function trailMeta(t: Trail, gainM?: number | null) {
  const bits = [fmtMiles(t.lengthM)];
  if (t.loop) bits.push("loop");
  if (gainM != null) bits.push(`↑ ${Math.round((gainM * FT_PER_M) / 10) * 10} ft`);
  return bits.join(" · ");
}

function render() {
  document.body.dataset.view = view.kind;
  drawTrails();
  switch (view.kind) {
    case "list": {
      const from = myPos ?? (searchedCenter ? ([searchedCenter.lat, searchedCenter.lng] as LatLon) : null);
      sheet.innerHTML = status
        ? `<p class="status">${esc(status)}</p>`
        : `<ul class="list">${trails
            .slice(0, 50)
            .map(
              (t, i) => `<li><button data-i="${i}"><b>${esc(t.name)}</b><span>${trailMeta(t)}${
                from ? ` · ${fmtMiles(map.distance(toLL(from), toLL(t.start)))} away` : ""
              }</span></button></li>`,
            )
            .join("")}</ul>`;
      sheet.querySelectorAll<HTMLButtonElement>("button[data-i]").forEach((b) =>
        b.addEventListener("click", () => openTrail(trails[Number(b.dataset.i)])),
      );
      break;
    }
    case "detail": {
      const t = view.trail;
      sheet.innerHTML = `
        <button class="close" aria-label="Back">✕</button>
        <h2>${esc(t.name)}</h2>
        <p class="meta">${trailMeta(t, view.gainM)}</p>
        <p class="sub">Starts at ${t.startKind === "trail end" ? "the trail's end (no mapped trailhead)" : `a mapped ${t.startKind}`}</p>
        <div class="actions">
          <a class="btn" href="${directionsUrl(t.start)}" target="_blank" rel="noopener">Directions</a>
          <button class="btn primary" id="go">Start hike</button>
        </div>`;
      sheet.querySelector(".close")!.addEventListener("click", back);
      $("go").addEventListener("click", () => startTracking(t));
      break;
    }
    case "tracking":
    case "done": {
      const done = view.kind === "done";
      sheet.innerHTML = `
        <h2>${esc(view.trail.name)}</h2>
        <div class="stats"><div><b id="dist"></b><span>distance</span></div><div><b id="time"></b><span>time</span></div></div>
        <div class="actions">${
          done ? `<button class="btn primary" id="end">Done</button>` : `<button class="btn" id="end">Stop</button>`
        }</div>`;
      $("end").addEventListener("click", () => {
        if (!done) {
          if (confirm("Stop tracking this hike?")) stopTracking();
        } else {
          trackLine.setLatLngs([]);
          back();
        }
      });
      renderStats();
      break;
    }
  }
}

function back() {
  view = { kind: "list" };
  render();
}

// ---------- controls ----------
$<HTMLFormElement>("search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("q");
  const q = input.value.trim();
  if (!q) return;
  input.blur();
  status = "Searching…";
  view = { kind: "list" };
  render();
  try {
    const hit = await geocode(q);
    if (!hit) {
      status = `Couldn't find “${q}”.`;
      return render();
    }
    map.setView(toLL(hit.at), 12, { animate: false });
    await searchHere();
  } catch {
    status = "Search failed. Check your connection.";
    render();
  }
});
$("locate").addEventListener("click", () => {
  follow = true;
  if (myPos) map.setView(toLL(myPos), Math.max(map.getZoom(), 13));
  startWatching();
});
here.addEventListener("click", searchHere);

// ---------- boot ----------
function boot() {
  try {
    const saved = JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? "null");
    if (saved?.trail && saved?.track) {
      map.fitBounds(L.latLngBounds(saved.trail.lines.flat().map(toLL)));
      startTracking(saved.trail, saved.track);
      startWatching();
      return;
    }
  } catch {}
  status = "Finding your location…";
  render();
  if (!navigator.geolocation) {
    status = "Search a place to find hikes.";
    return render();
  }
  navigator.geolocation.getCurrentPosition(
    (p) => {
      map.setView([p.coords.latitude, p.coords.longitude], 12, { animate: false });
      onFix(p);
      searchHere();
    },
    () => {
      status = "Search a place to find hikes.";
      render();
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
  );
  startWatching();
}
boot();

if ("serviceWorker" in navigator && import.meta.env.PROD) navigator.serviceWorker.register("/sw.js").catch(() => {});
