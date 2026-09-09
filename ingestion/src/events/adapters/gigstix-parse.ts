/**
 * Pure parser for a GIGS TIX (`new.gigstix.com`) event page.
 *
 * GIGS TIX runs WordPress with the "Event Champ" theme. Observed 2026-09-08:
 *
 *  - The page carries NO schema.org `Event` / `MusicEvent` JSON-LD — only
 *    Yoast's generic `WebPage`/`Organization` graph. So this is a
 *    server-rendered HTML parser, anchored on the theme's stable, semantic
 *    `gt-*` class names and the Serbian field LABELS ("Datum i vreme
 *    održavanja", "Mesto", "Lokacija", "Organizator"), never on layout
 *    position or a single fragile selector.
 *  - The stable event id is the WordPress post id (`body class="… postid-NNNN"`,
 *    also in the `?p=NNNN` shortlink and the `wp-json/wp/v2/event/NNNN` link).
 *  - Lineup is only ever inline prose in the description — never structured —
 *    so it is deliberately NOT extracted (see `reported.lineupAvailable`).
 *  - The public WP REST API (`/wp-json/wp/v2/event/NNNN`) returns 401, so it is
 *    not used.
 *
 * This function is pure: no network, no clock, deterministic.
 */

import { blockText, collapseWs, inlineText } from "../text.ts";
import { parseSerbianDateTime } from "../time.ts";
import type { NormalizedEvent, ParseResult } from "../types.ts";
import {
  cleanGigstixTitle as cleanTitle,
  firstMatch,
  metaContent,
  stripNoise,
} from "./gigstix-html.ts";

const NOT_FOUND_MARKERS = [
  "stranica nije pronađena",
  "stranica nije pronadjena",
  "page not found",
  "404",
];

/** Every `<li class="gt-*">` in the detail box, keyed by its label text. */
interface DetailRow {
  liClass: string;
  label: string;
  innerHtml: string;
  innerText: string;
}

function extractDetailRows(html: string): DetailRow[] {
  const boxStart = html.search(/<div[^>]*class=["'][^"']*gt-content-detail-box/i);
  const scope = boxStart >= 0 ? html.slice(boxStart, boxStart + 8000) : "";
  if (!scope) return [];

  const rows: DetailRow[] = [];
  const liRe = /<li[^>]*class=["'](gt-[^"']*)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(scope)) !== null) {
    const from = m.index;
    const window = scope.slice(from, from + 1600);
    const label = firstMatch(
      /<div[^>]*class=["'][^"']*gt-title[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      window,
    );
    const innerHtml = firstMatch(
      /<div[^>]*class=["'][^"']*gt-inner[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      window,
    );
    if (label == null && innerHtml == null) continue;
    rows.push({
      liClass: m[1],
      label: collapseWs(inlineText(label ?? "")),
      innerHtml: innerHtml ?? "",
      innerText: collapseWs(inlineText(innerHtml ?? "")),
    });
  }
  return rows;
}

function findRow(
  rows: DetailRow[],
  opts: { liClass?: string; labelStartsWith?: string },
): DetailRow | undefined {
  return rows.find((row) => {
    if (opts.liClass && row.liClass.split(/\s+/).includes(opts.liClass)) return true;
    if (
      opts.labelStartsWith &&
      row.label.toLowerCase().startsWith(opts.labelStartsWith.toLowerCase())
    ) {
      return true;
    }
    return false;
  });
}

function slugFrom(innerHtml: string, kind: "venue" | "location"): string | null {
  return firstMatch(new RegExp(`/${kind}/([a-z0-9-]+)/`, "i"), innerHtml);
}

function anchorText(innerHtml: string): string {
  const a = firstMatch(/<a[^>]*>([\s\S]*?)<\/a>/i, innerHtml);
  return collapseWs(inlineText(a ?? innerHtml));
}

function extractDescription(html: string): string | null {
  // The "O događaju" section, up to the start of the next section.
  const re =
    /<div[^>]*class=["'][^"']*gt-section-title[^"']*["'][^>]*>\s*O\s*doga[^<]*<\/div>\s*<div[^>]*class=["'][^"']*gt-content[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]*class=["'][^"']*gt-section(?:-title)?["']|<div[^>]*class=["'][^"']*gt-event-|<\/div>\s*<\/div>\s*<\/div>)/i;
  const block = firstMatch(re, html);
  if (!block) return null;
  const text = blockText(block);
  return text.length > 0 ? text : null;
}

function detectStatusMarker(haystack: string): {
  status?: "cancelled" | "postponed";
  marker?: string;
} {
  const lower = haystack.toLowerCase();
  if (/\botkazan|\botkaz(a|u)|отказан/.test(lower)) {
    return { status: "cancelled", marker: "otkazano" };
  }
  if (/\bodlo[žz]|odgo[đd]|одлож|pomeren|novi datum|нови датум/.test(lower)) {
    return { status: "postponed", marker: "odlozeno" };
  }
  return {};
}

export function parseGigstixEvent(html: string, url: string): ParseResult {
  const clean = stripNoise(html);

  const bodyClass = firstMatch(/<body[^>]*class=["']([^"']*)["']/i, clean) ?? "";
  const pageClass =
    firstMatch(/class=["']([^"']*\bgt-page-content\b[^"']*)["']/i, clean) ?? "";
  const classSoup = `${bodyClass} ${pageClass}`;

  const rawTitle =
    firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, clean) ??
    metaContent(clean, "og:title") ??
    "";
  const title = cleanTitle(rawTitle);
  const titleLower = title.toLowerCase();

  if (!title) {
    return { ok: false, reason: "missing-title" };
  }
  if (NOT_FOUND_MARKERS.some((marker) => titleLower.includes(marker))) {
    return { ok: false, reason: "not-found-page", detail: title };
  }

  // ---- external id -------------------------------------------------------
  const postId =
    firstMatch(/\bpostid-(\d+)\b/, bodyClass) ??
    firstMatch(/wp-json\/wp\/v2\/event\/(\d+)/, clean) ??
    firstMatch(/[?&]p=(\d+)\b/, clean);
  const slug = firstMatch(/\/event\/([^/?#"']+)/i, url);
  const externalId = postId ?? slug;
  if (!externalId) {
    return { ok: false, reason: "missing-external-id" };
  }

  // ---- detail rows ------------------------------------------------------
  const rows = extractDetailRows(clean);
  if (rows.length === 0) {
    return { ok: false, reason: "missing-details" };
  }

  const dateRow =
    findRow(rows, { liClass: "gt-start-date" }) ??
    findRow(rows, { labelStartsWith: "datum" });
  const dateText = dateRow?.innerText ?? "";
  const parsedStart = dateText ? parseSerbianDateTime(dateText) : null;
  if (!parsedStart) {
    return { ok: false, reason: "unparseable-date", detail: dateText || "(no date row)" };
  }

  const endRow = findRow(rows, { labelStartsWith: "traje do" });
  const parsedEnd = endRow ? parseSerbianDateTime(endRow.innerText) : null;

  const venueRow =
    findRow(rows, { liClass: "gt-venue" }) ??
    findRow(rows, { labelStartsWith: "lokacija" });
  const venueName = venueRow ? anchorText(venueRow.innerHtml) : "";
  const venueSlug = venueRow ? slugFrom(venueRow.innerHtml, "venue") : null;

  const cityRow =
    findRow(rows, { liClass: "gt-locations" }) ??
    findRow(rows, { labelStartsWith: "mesto" });
  const cityText = cityRow ? anchorText(cityRow.innerHtml) : "";

  // Some GIGS TIX events name only a city ("Mesto"), no specific venue
  // ("Lokacija") — a real listing state, not a parse error. Only a total
  // absence of location is a failure.
  if (!venueName && !cityText) {
    return { ok: false, reason: "missing-location" };
  }
  const citySlug =
    (cityRow ? slugFrom(cityRow.innerHtml, "location") : null) ??
    firstMatch(/\blocation-([a-z0-9-]+)\b/, classSoup);

  const promoterRow = findRow(rows, { labelStartsWith: "organizator" });
  const promoterFull = promoterRow?.innerText || undefined;
  // GIGS TIX sometimes appends the organiser's legal address / registration to
  // the name. Keep the leading name as the canonical value, the full string in
  // `reported`.
  const promoter = promoterFull
    ? collapseWs(promoterFull.split(/,|\s{2,}| MB \d| PIB \d/)[0])
    : undefined;

  const eventTypeRow = findRow(rows, { labelStartsWith: "vrsta doga" });
  const eventTypeText = eventTypeRow?.innerText || undefined;

  // ---- categories -----------------------------------------------------
  // From the page-content class list AND from any `/eventcat/<slug>/` links in
  // the detail rows (the "Vrsta događaja" row), so a page that only carries the
  // category as a link is still covered.
  const categories = [
    ...new Set([
      ...Array.from(classSoup.matchAll(/\beventcat-([a-z0-9-]+)\b/g)).map((m) => m[1]),
      ...Array.from(clean.matchAll(/\/eventcat\/([a-z0-9-]+)\//g)).map((m) => m[1]),
    ]),
  ];

  // ---- tickets -------------------------------------------------------
  const ticketMatch = clean.match(
    /href=["'](https?:\/\/bilet\.gigstix\.com\/[^"']*\/sectionGroup\/index\/(\d+)[^"']*)["']/i,
  );
  const ticketUrl = ticketMatch ? ticketMatch[1] : undefined;
  const ticketingId = ticketMatch ? ticketMatch[2] : undefined;
  const priceText = collapseWs(
    inlineText(
      firstMatch(
        /<div[^>]*class=["'][^"']*gt-tickets-price[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
        clean,
      ) ?? "",
    ),
  );

  // ---- description / media -----------------------------------------
  const ogImage = metaContent(clean, "og:image") ?? undefined;
  const ogDescription = metaContent(clean, "og:description") ?? undefined;
  const description = extractDescription(clean) ?? ogDescription;

  // ---- lifecycle status (explicit signal only; omission is NEVER cancellation) --
  // Scan the human-readable text only. The `odlozeno-otkazano` category slug is
  // a combined "postponed OR cancelled" bucket and must NOT be fed to the
  // cancellation keyword regex (its slug literally contains "otkaz"); the
  // category on its own resolves to "postponed".
  const marker = detectStatusMarker(`${title}\n${description ?? ""}`);
  const status: NormalizedEvent["status"] =
    marker.status ??
    (categories.includes("odlozeno-otkazano") ? "postponed" : undefined);

  const reported = {
    postId: postId ?? null,
    slug: slug ?? null,
    dateText,
    endText: endRow?.innerText ?? null,
    cityText: cityText || null,
    citySlug: citySlug ?? null,
    venueText: venueName || null,
    venueNamedInSource: venueName.length > 0,
    venueSlug: venueSlug ?? null,
    eventTypeText: eventTypeText ?? null,
    promoterText: promoterFull ?? null,
    ticketUrl: ticketUrl ?? null,
    ticketingId: ticketingId ?? null,
    priceText: priceText || null,
    categories,
    ogDescription: ogDescription ?? null,
    ogImage: ogImage ?? null,
    lineupAvailable: false,
    statusMarker: marker.marker ?? null,
  };

  const event: NormalizedEvent = {
    externalId: String(externalId),
    sourceUrl: url,
    title,
    description: description || undefined,
    startLocal: parsedStart.local,
    endLocal: parsedEnd?.local,
    startPrecision: parsedStart.precision,
    venue: {
      name: venueName,
      sourceVenueId: venueSlug ?? undefined,
      city: cityText || undefined,
    },
    promoter,
    ticketUrl,
    coverImageUrl: ogImage,
    status,
    reported,
  };

  return { ok: true, event };
}
