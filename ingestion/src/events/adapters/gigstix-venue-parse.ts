/**
 * Pure parser for a GIGS TIX venue page (`new.gigstix.com/venue/<slug>/`).
 *
 * Observed 2026-09-08 (Event Champ "venue" custom post type):
 *  - stable id: WordPress post id (`body class="… postid-NNNN"`), also the
 *    `?p=NNNN` shortlink;
 *  - `<li class="gt-locations">` → "Mesto" → city (also `og:description`
 *    = "<City>, Srbija" and the `location-<slug>` body class);
 *  - `<li class="gt-address">` → "Adresa" → a plain street address;
 *  - the map widget carries `data-lat="…" data-lng="…"` → coordinates.
 *
 * Pure: no network, no clock, deterministic.
 */

import { collapseWs, inlineText } from "../text.ts";
import {
  cleanGigstixTitle,
  firstMatch,
  metaContent,
  stripNoise,
} from "./gigstix-html.ts";

export interface SourceVenueParse {
  /** Stable venue id on the source (WordPress post id, else the slug). */
  externalId: string;
  sourceUrl: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  /** City text exactly as the source states it (e.g. "Beograd"). */
  city: string | null;
}

export type GigstixVenueResult =
  | { ok: true; venue: SourceVenueParse }
  | { ok: false; reason: string };

const NOT_FOUND_MARKERS = ["stranica nije pron", "page not found"];

function detailInner(html: string, label: string): string | null {
  // <li class="gt-*"> … <div class="gt-title">LABEL</div><div class="gt-inner">VALUE</div>
  const re = new RegExp(
    `<div[^>]*class=["'][^"']*gt-title[^"']*["'][^>]*>\\s*${label}[^<]*<\\/div>\\s*` +
      `<div[^>]*class=["'][^"']*gt-inner[^"']*["'][^>]*>([\\s\\S]*?)<\\/div>`,
    "i",
  );
  const inner = firstMatch(re, html);
  return inner != null ? collapseWs(inlineText(inner)) : null;
}

function coord(value: string | null, min: number, max: number): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

export function parseGigstixVenue(html: string, url: string): GigstixVenueResult {
  const clean = stripNoise(html);

  const bodyClass = firstMatch(/<body[^>]*class=["']([^"']*)["']/i, clean) ?? "";
  const rawTitle =
    firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, clean) ??
    metaContent(clean, "og:title") ??
    "";
  const name = cleanGigstixTitle(rawTitle);
  if (!name) return { ok: false, reason: "missing-name" };
  if (NOT_FOUND_MARKERS.some((m) => name.toLowerCase().includes(m))) {
    return { ok: false, reason: "not-found-page" };
  }
  if (!/\bsingle-venue\b|\bvenue-template\b|\btype-venue\b/i.test(bodyClass)) {
    return { ok: false, reason: "not-a-venue-page" };
  }

  const externalId =
    firstMatch(/\bpostid-(\d+)\b/, bodyClass) ??
    firstMatch(/[?&]p=(\d+)\b/, clean) ??
    firstMatch(/\/venue\/([^/?#"']+)/i, url) ??
    "";
  if (!externalId) return { ok: false, reason: "missing-external-id" };

  const address = detailInner(clean, "Adresa");

  // City: the "Mesto" row → else og:description "<City>, Srbija".
  const mestoRow = detailInner(clean, "Mesto");
  const ogCity = metaContent(clean, "og:description");
  const city =
    (mestoRow && mestoRow.trim()) ||
    (ogCity ? ogCity.split(",")[0].trim() : "") ||
    null;

  const latRaw = firstMatch(/data-lat=["']([-0-9.]+)["']/i, clean);
  const lngRaw = firstMatch(/data-lng=["']([-0-9.]+)["']/i, clean);
  let latitude = coord(latRaw, -90, 90);
  let longitude = coord(lngRaw, -180, 180);
  // A missing map often renders as 0/0 — not a real location.
  if (latitude === 0 && longitude === 0) {
    latitude = null;
    longitude = null;
  }

  return {
    ok: true,
    venue: {
      externalId: String(externalId),
      sourceUrl: url,
      name,
      address: address || null,
      latitude,
      longitude,
      city,
    },
  };
}
