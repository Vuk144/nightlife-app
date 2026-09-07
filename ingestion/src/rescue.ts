/**
 * Layer C — curated, city-specific venue rescue.
 *
 * For real nightlife / music venues that OpenStreetMap tags too weakly for
 * Layers A or B to accept safely. It is a DATA table, never referenced by the
 * global classifier logic — city venue names never appear in Layer A/B code.
 *
 * A rescue never overrides a hard exclusion (lifecycle / shop / office /
 * lodging-only), and it is completely independent of event data: a rescued
 * venue is valid whether or not any event is ever attached to it.
 *
 * Every entry is sourced from the project's Recall Audit v1/v2 and the
 * finalised product scope. Nothing is invented.
 *
 * MATCHING RULE:
 *   - if `osmRef` is set  -> the entry matches ONLY that exact OSM object
 *     (so a node + way that both carry the venue's name do not both get
 *     rescued — only the canonical object does);
 *   - if `osmRef` is unset -> the entry matches by normalized-name equality
 *     with any alias, and the query adds a name clause for it.
 *
 * The `osmRef` values below were verified with a targeted Overpass lookup on
 * 2026-09-07 (each object's tags and wikidata id checked). Re-verify before a
 * production import if OSM has since changed.
 */

import type { VenueCategory } from "./types.ts";
import { computeNameNormalized } from "./name.ts";

export interface RescueEntry {
  countryId: string;
  cityName: string;
  name: string;
  /** Spellings/variants — used for the query fallback and (osmRef-less) match. */
  aliases: string[];
  category: VenueCategory;
  /** Confirmed canonical OSM object: "node/123" | "way/123" | "relation/123". */
  osmRef?: string;
  note: string;
}

export const RESCUE_ENTRIES: RescueEntry[] = [
  {
    countryId: "RS", cityName: "Belgrade",
    name: "Dom omladine Beograda",
    aliases: ["Dom omladine Beograda", "Dom omladine", "Дом омладине Београда", "Дом омладине"],
    category: "concert_hall",
    osmRef: "way/41234985",
    note: "Major concert & club venue. OSM way/41234985 amenity=arts_centre wikidata=Q4882656 — no music signal (Recall Audit v2). A tag-less node/1618643087 with the same name is a stray label, not rescued.",
  },
  {
    countryId: "RS", cityName: "Belgrade",
    name: "Studentski kulturni centar (SKC)",
    aliases: ["Studentski kulturni centar", "SKC", "Студентски културни центар", "СКЦ"],
    category: "concert_hall",
    osmRef: "node/12872107296",
    note: "Concerts & club nights. OSM node/12872107296 amenity=arts_centre wikidata=Q3500923 — no music signal (Recall Audit v2).",
  },
  {
    countryId: "RS", cityName: "Belgrade",
    name: "KC Grad",
    aliases: ["KC Grad", "Kulturni centar Grad", "КЦ Град", "Културни центар Град"],
    category: "nightlife_venue",
    osmRef: "node/4118716889",
    note: "Savamala cultural centre — DJ nights & concerts. OSM node/4118716889 amenity=arts_centre wikidata=Q110049827 — no music signal (Recall Audit v2).",
  },
  {
    countryId: "RS", cityName: "Belgrade",
    name: "Bitef Art Café",
    aliases: ["Bitef Art Café", "Bitef Art Cafe", "Битеф арт кафе"],
    category: "concert_hall",
    osmRef: "node/6844070707",
    note: "Live-music / events venue. OSM node/6844070707 amenity=events_venue wikidata=Q85992064 — no music signal (Recall Audit v2). Distinct from BITEF teatar (node/12856588350, amenity=theatre) which is NOT rescued.",
  },
  {
    countryId: "RS", cityName: "Belgrade",
    name: "Cvijeta Zuzorić",
    aliases: ["Cvijeta Zuzorić", "Umetnički paviljon Cvijeta Zuzorić", "Уметнички павиљон Цвијета Зузорић", "Цвијета Зузорић"],
    category: "nightlife_venue",
    osmRef: "way/23671766",
    note: "Art pavilion — hosts events / parties. OSM way/23671766 amenity=arts_centre wikidata=Q3373107. The v1 rescue missed it because the anchored name clause did not match the OSM name 'Уметнички павиљон „Цвијета Зузорић”'; fixed with a confirmed osmRef (Recall Audit v2).",
  },
  {
    countryId: "RS", cityName: "Belgrade",
    name: "Kolarac",
    aliases: ["Kolarac", "Kolarčeva zadužbina", "Zadužbina Ilije M. Kolarca", "Задужбина Илије М. Коларца", "Коларац"],
    category: "concert_hall",
    osmRef: "way/393274192",
    note: "Concert hall — classical & world music. OSM way/393274192 amenity=arts_centre wikidata=Q3075477. A separate node/5834355485 tagged amenity=restaurant 'Коларац' is not rescued (product scope: concert halls in scope) (Recall Audit v2).",
  },
  {
    countryId: "RS", cityName: "Belgrade",
    name: "Tri šešira",
    aliases: ["Tri šešira", "Tri sesira", "Три шешира"],
    category: "kafana",
    osmRef: "way/150590534",
    note: "Skadarlija bohemian kafana, live starogradska muzika nightly. OSM way/150590534 amenity=restaurant wikidata=Q12760217 (Recall Audit v2).",
  },
  {
    countryId: "RS", cityName: "Belgrade",
    name: "Dva jelena",
    aliases: ["Dva jelena", "Два јелена"],
    category: "kafana",
    osmRef: "node/1634937968",
    note: "Skadarlija kafana, live music. OSM node/1634937968 amenity=restaurant wikidata=Q65200062 (Recall Audit v2).",
  },
  {
    countryId: "RS", cityName: "Belgrade",
    name: "Šešir moj",
    aliases: ["Šešir moj", "Sesir moj", "Шешир мој"],
    category: "kafana",
    osmRef: "node/1634938018",
    note: "Skadarlija kafana, live music. OSM node/1634938018 amenity=restaurant (Recall Audit v2).",
  },
  {
    countryId: "RS", cityName: "Belgrade",
    name: "Ima dana",
    aliases: ["Ima dana", "Има дана"],
    category: "kafana",
    osmRef: "way/149635378",
    note: "Skadarlija kafana, live music. OSM way/149635378 amenity=restaurant wikidata=Q110048715 (Recall Audit v2).",
  },
  {
    countryId: "RS", cityName: "Belgrade",
    name: "Zlatni bokal",
    aliases: ["Zlatni bokal", "Zlatan bokal", "Златни бокал", "Златан бокал"],
    category: "kafana",
    osmRef: "node/1634937981",
    note: "Skadarlija kafana, live music. OSM node/1634937981 amenity=restaurant, name 'Златан бокал' (Recall Audit v2).",
  },
  {
    countryId: "RS", cityName: "Belgrade",
    name: "Grčka kraljica",
    aliases: ["Grčka kraljica", "Grcka kraljica", "Грчка краљица"],
    category: "kafana",
    osmRef: "node/13045146275",
    note: "Skadarlija kafana, live music. OSM node/13045146275 amenity=restaurant. A separate tag-less way/170969052 building=retail with the same name is not rescued (Recall Audit v2).",
  },
  {
    countryId: "RS", cityName: "Belgrade",
    name: "Dorian Grey",
    aliases: ["Dorian Grey", "Dorijan Grej"],
    category: "bar",
    osmRef: "node/6782874303",
    note: "Known old-town cocktail bar (Kralja Petra). OSM node/6782874303 amenity=cafe + bar=yes — the stricter Recall v2 cafe rule (bar=yes on a cafe is only a weak signal) correctly drops it; rescued here as a confirmed genuine bar rather than by weakening the global cafe rule (Recall Audit v2 QA).",
  },
];

/**
 * OSM node/way pairs that clearly represent the SAME real venue but that the
 * matching tiers cannot safely merge (a venue node + its building way). The
 * confirmed `osmRef` above picks the canonical object; the other is left to
 * normal classification (usually excluded). Documented here as manual-merge
 * review candidates — the global matching algorithm is NOT changed.
 */
export const KNOWN_DUPLICATE_OSM_OBJECTS: {
  venue: string;
  canonical: string;
  other: string;
  otherFate: string;
}[] = [
  { venue: "Dom omladine Beograda", canonical: "way/41234985", other: "node/1618643087", otherFate: "tag-less label node — excluded" },
  { venue: "Kolarac", canonical: "way/393274192", other: "node/5834355485", otherFate: "amenity=restaurant with no signal — excluded" },
  { venue: "Grčka kraljica", canonical: "node/13045146275", other: "way/170969052", otherFate: "building=retail, no amenity — excluded" },
];

function entriesFor(countryId: string, cityName: string): RescueEntry[] {
  return RESCUE_ENTRIES.filter(
    (e) => e.countryId === countryId && e.cityName === cityName,
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Alternation for the Overpass `["name"~"...",i]` fallback clause — only for
 * entries WITHOUT a confirmed `osmRef` (ref'd entries are fetched by id).
 * Empty string when every entry is ref'd or the city has no entries.
 */
export function rescueNameOverpass(countryId: string, cityName: string): string {
  const alts = entriesFor(countryId, cityName)
    .filter((e) => !e.osmRef)
    .flatMap((e) => e.aliases)
    .map(escapeRegex);
  return alts.join("|");
}

/** Confirmed OSM refs to fetch explicitly by id, grouped by element type. */
export function rescueOsmRefs(
  countryId: string,
  cityName: string,
): { node: number[]; way: number[]; relation: number[] } {
  const out = { node: [] as number[], way: [] as number[], relation: [] as number[] };
  for (const e of entriesFor(countryId, cityName)) {
    if (!e.osmRef) continue;
    const [type, id] = e.osmRef.split("/");
    const n = Number(id);
    if ((type === "node" || type === "way" || type === "relation") && Number.isFinite(n)) {
      out[type].push(n);
    }
  }
  return out;
}

const normalizedAliasCache = new WeakMap<RescueEntry, Set<string>>();
function normalizedAliases(entry: RescueEntry): Set<string> {
  let set = normalizedAliasCache.get(entry);
  if (!set) {
    set = new Set(entry.aliases.map(computeNameNormalized).filter(Boolean));
    normalizedAliasCache.set(entry, set);
  }
  return set;
}

/**
 * The curated rescue entry an OSM element matches for this city, if any.
 * An entry WITH an `osmRef` matches only that exact object; an entry WITHOUT
 * one matches by normalized-name equality with an alias.
 */
export function findRescue(
  countryId: string,
  cityName: string,
  ref: string,
  nameNormalized: string,
): RescueEntry | null {
  for (const entry of entriesFor(countryId, cityName)) {
    if (entry.osmRef) {
      if (entry.osmRef === ref) return entry;
      continue;
    }
    if (nameNormalized && normalizedAliases(entry).has(nameNormalized)) return entry;
  }
  return null;
}
