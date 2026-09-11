/**
 * Characterization of `../src/geo.ts#haversineMeters`.
 *
 * The only production caller is `../src/matching.ts` (Tier 3 proximity guard +
 * the advisory `reviewNotesForNewVenues`). Every distance it computes is
 * between two points inside a SINGLE city ingestion target — a few hundred
 * metres to a few tens of km apart — or between a real point and a `NaN`
 * placeholder (missing coordinates). These tests pin the behaviour across that
 * reachable domain and document the formula's known edge behaviour outside it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineMeters } from "../src/geo.ts";

// ── mathematical contract ─────────────────────────────────────────────

test("[contract] identical coordinates -> exactly 0", () => {
  assert.equal(haversineMeters({ latitude: 44.8, longitude: 20.4 }, { latitude: 44.8, longitude: 20.4 }), 0);
  assert.equal(haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 }), 0);
  assert.equal(haversineMeters({ latitude: -33.9, longitude: 151.2 }, { latitude: -33.9, longitude: 151.2 }), 0);
});

test("[contract] a known short distance (two Belgrade landmarks ~0.94 km)", () => {
  const d = haversineMeters(
    { latitude: 44.8167, longitude: 20.46 },
    { latitude: 44.8225, longitude: 20.4514 },
  );
  assert.ok(Math.abs(d - 935.97) < 1, `expected ~936 m, got ${d}`);
});

test("[contract] one degree of latitude ~ 111.19 km anywhere", () => {
  const atEquator = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
  const upNorth = haversineMeters({ latitude: 60, longitude: 20 }, { latitude: 61, longitude: 20 });
  assert.ok(Math.abs(atEquator - 111194.93) < 0.5);
  // meridians are great circles, so a degree of latitude is the same length everywhere
  assert.ok(Math.abs(atEquator - upNorth) < 1e-6);
});

test("[contract] one degree of longitude shrinks with latitude (cos weighting)", () => {
  const eq = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 });
  const bg = haversineMeters({ latitude: 44.8, longitude: 20 }, { latitude: 44.8, longitude: 21 });
  const arctic = haversineMeters({ latitude: 80, longitude: 0 }, { latitude: 80, longitude: 1 });
  assert.ok(eq > bg && bg > arctic, `${eq} > ${bg} > ${arctic}`);
  // ratio tracks cos(latitude)
  assert.ok(Math.abs(bg / eq - Math.cos((44.8 * Math.PI) / 180)) < 1e-3);
});

test("[contract] symmetric: d(a,b) === d(b,a) exactly", () => {
  const pairs: [[number, number], [number, number]][] = [
    [[44.8, 20.4], [45.1, 20.9]],
    [[0, 0], [10, -170]],
    [[-33.87, 151.21], [51.5, -0.12]],
    [[89, 1], [-89, 179]],
  ];
  for (const [[aLat, aLon], [bLat, bLon]] of pairs) {
    const ab = haversineMeters({ latitude: aLat, longitude: aLon }, { latitude: bLat, longitude: bLon });
    const ba = haversineMeters({ latitude: bLat, longitude: bLon }, { latitude: aLat, longitude: aLon });
    assert.equal(ab, ba, `${aLat},${aLon} <-> ${bLat},${bLon}`);
  }
});

test("[contract] result is finite and non-negative across valid coordinates", () => {
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 5000; i++) {
    const a = { latitude: rnd() * 180 - 90, longitude: rnd() * 360 - 180 };
    const b = { latitude: rnd() * 180 - 90, longitude: rnd() * 360 - 180 };
    const d = haversineMeters(a, b);
    assert.ok(Number.isFinite(d) && d >= 0, `d=${d} for ${JSON.stringify(a)} ${JSON.stringify(b)}`);
    // never more than half the Earth's circumference
    assert.ok(d <= 20_015_090, `d=${d} exceeds half-circumference`);
  }
});

// ── antimeridian / longitude wrap ─────────────────────────────────────

test("[contract] antimeridian crossing takes the short way (~22 m, not ~40000 km)", () => {
  const d = haversineMeters(
    { latitude: 0, longitude: 179.9999 },
    { latitude: 0, longitude: -179.9999 },
  );
  assert.ok(Math.abs(d - 22.24) < 0.5, `expected ~22 m, got ${d}`);
});

test("[contract] longitude is periodic: L and L+360 are the same point", () => {
  const d = haversineMeters({ latitude: 44.8, longitude: 20.4 }, { latitude: 44.8, longitude: 380.4 });
  assert.ok(d < 1e-6, `expected ~0, got ${d}`);
});

// ── poles ────────────────────────────────────────────────────────────

test("[contract] near-pole: two points on the 89.9° parallel 180° apart are ~22 km, not antipodal", () => {
  const d = haversineMeters({ latitude: 89.9, longitude: 0 }, { latitude: 89.9, longitude: 180 });
  assert.ok(Math.abs(d - 22238.99) < 1, `expected ~22.24 km, got ${d}`);
});

test("[contract] pole to pole ~ half the Earth's circumference (~20015 km)", () => {
  const d = haversineMeters({ latitude: 90, longitude: 0 }, { latitude: -90, longitude: 0 });
  assert.ok(Math.abs(d - 20_015_086.8) < 1, `got ${d}`);
});

// ── Earth radius domain constant ─────────────────────────────────────

test("[constant] EARTH_RADIUS_M implies a spherical circumference of ~40030 km", () => {
  // exact antipodes span half the circumference; x2 = full lap.
  const half = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 });
  const circumference = half * 2;
  // mean-Earth sphere (R = 6 371 km) -> ~40 030 km. WGS84 equatorial is ~40 075 km;
  // the <0.2% gap is the documented spherical approximation, fine at guard scale.
  assert.ok(Math.abs(circumference - 40_030_173) < 1000, `got ${circumference}`);
});

// ── caller unit contract: the result is metres ──────────────────────

test("[units] a 200 m north-south offset returns ~200 (matcher thresholds are metres)", () => {
  const metresPerDegLat = 111194.9266;
  const d = haversineMeters(
    { latitude: 44.8, longitude: 20.4 },
    { latitude: 44.8 + 200 / metresPerDegLat, longitude: 20.4 },
  );
  assert.ok(Math.abs(d - 200) < 0.01, `got ${d}`);
});

// ── input contract: what actually reaches this function ─────────────

test("[input][characterization] a NaN coordinate yields NaN (never throws) — callers read this as 'no distance link'", () => {
  assert.ok(Number.isNaN(haversineMeters({ latitude: Number.NaN, longitude: 20.4 }, { latitude: 44.8, longitude: 20.4 })));
  assert.ok(Number.isNaN(haversineMeters({ latitude: 44.8, longitude: 20.4 }, { latitude: 44.8, longitude: Number.NaN })));
  // and NaN fails every ordered comparison the matcher makes, so it can only fall through
  const d = haversineMeters({ latitude: Number.NaN, longitude: Number.NaN }, { latitude: 44.8, longitude: 20.4 });
  assert.equal(d <= 300, false);
  assert.equal(d <= 1000, false);
});

test("[input][characterization] Infinity coordinates yield NaN (never throws)", () => {
  assert.ok(Number.isNaN(haversineMeters({ latitude: Infinity, longitude: 0 }, { latitude: 0, longitude: 0 })));
  assert.ok(Number.isNaN(haversineMeters({ latitude: 0, longitude: -Infinity }, { latitude: 0, longitude: 0 })));
});

// ── latent: near-antipodal h > 1 (OUTSIDE the reachable domain) ─────

test("[latent] near-antipodal points can round to NaN via floating-point h > 1", () => {
  // KNOWN LIMITATION of the bare Haversine: for two points ~20 000 km apart the
  // intermediate `h` can land at 1 + 2^-52, so `Math.asin(Math.sqrt(h))` is NaN.
  // This is UNREACHABLE from the ingestion pipeline — every distance the matcher
  // computes is between two venues in the same city (< ~50 km). Pinned so the
  // fragility stays visible; a `Math.min(1, h)` clamp is the fix IF a caller
  // ever computes globe-spanning distances.
  const a = { latitude: 64.04807582987064, longitude: 90.83065896262872 };
  const b = { latitude: -64.04807598517122, longitude: 270.83065873099673 };
  assert.ok(Number.isNaN(haversineMeters(a, b)));

  // meanwhile EXACT antipodes (the reachable maximum, e.g. pole-to-pole) are fine
  assert.equal(Number.isNaN(haversineMeters({ latitude: 10, longitude: 20 }, { latitude: -10, longitude: 200 })), false);
});
