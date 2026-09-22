import { haversine, nearestOnLines, type LatLon } from "./geo";

export interface Fix {
  at: LatLon;
  acc: number; // meters
  t: number; // epoch ms
}

export interface Track {
  trailId: string;
  startedAt: number;
  points: LatLon[];
  distanceM: number;
  offTrail: boolean;
  /** Consecutive fixes that disagreed with the current on/off state. */
  strikes: number;
}

export type TrackEvent = "left-trail" | "back-on-trail" | null;

const MAX_ACC = 50; // ignore fixes worse than this
const MIN_STEP = 8; // meters of movement before we count distance (GPS jitter)
const OFF_M = 40; // beyond this (plus accuracy slack) you're off the trail
const CONFIRM = 2; // fixes needed to flip state, so one bad fix doesn't alarm

export function newTrack(trailId: string, now = Date.now()): Track {
  return { trailId, startedAt: now, points: [], distanceM: 0, offTrail: false, strikes: 0 };
}

export function update(
  track: Track,
  fix: Fix,
  trail: LatLon[][],
): { track: Track; event: TrackEvent; toTrail: { d: number; at: LatLon } } {
  const toTrail = nearestOnLines(fix.at, trail);
  if (fix.acc > MAX_ACC) return { track, event: null, toTrail };

  let { points, distanceM, offTrail, strikes } = track;
  const last = points[points.length - 1];
  if (!last) points = [fix.at];
  else {
    const step = haversine(last, fix.at);
    if (step >= MIN_STEP) {
      points = [...points, fix.at];
      distanceM += step;
    }
  }

  const slack = Math.min(fix.acc, 25);
  const looksOff = offTrail ? toTrail.d > OFF_M - 10 + slack : toTrail.d > OFF_M + slack;
  let event: TrackEvent = null;
  if (looksOff !== offTrail) {
    strikes += 1;
    if (strikes >= CONFIRM) {
      offTrail = looksOff;
      strikes = 0;
      event = offTrail ? "left-trail" : "back-on-trail";
    }
  } else strikes = 0;

  return { track: { ...track, points, distanceM, offTrail, strikes }, event, toTrail };
}
