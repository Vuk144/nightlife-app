/**
 * Curated, human-verified venue matching data used by the deterministic
 * matcher (Tier 1 and Tier 3).
 *
 * These are LOOKUP TABLES, not heuristics. Every alias entry is hand-checked
 * and scoped to one (country, city), so "kst" in Belgrade can never collide
 * with "kst" somewhere else. Adding an entry is a deliberate curation step.
 */

export interface VenueAlias {
  /** ISO 3166-1 alpha-2, must match the ingestion target's countryId. */
  countryId: string;
  /** Must match the ingestion target's cityName. */
  cityName: string;
  /** An incoming `name_normalized` that should resolve to `canonicalName`. */
  aliasNormalized: string;
  /** The `name` of the existing venue this alias points to. */
  canonicalName: string;
  /** Why this alias exists — for the curation record, not used at runtime. */
  note?: string;
}

export const VENUE_ALIASES: VenueAlias[] = [
  {
    countryId: "RS",
    cityName: "Belgrade",
    aliasNormalized: "dragstor",
    canonicalName: "Drugstore",
    note: 'OSM carries the Serbian phonetic Cyrillic spelling "Драгстор".',
  },
  {
    countryId: "RS",
    cityName: "Belgrade",
    aliasNormalized: "studenata tehnike",
    canonicalName: "KST",
    note: 'KST = acronym of "Klub studenata tehnike" / "Клуб студената технике".',
  },
  {
    countryId: "RS",
    cityName: "Belgrade",
    aliasNormalized: "klub studenata tehnike",
    canonicalName: "KST",
    note: 'Full form, in case the OSM name keeps the leading "Klub".',
  },
];

/** Find a curated alias for a target city + an incoming normalized name. */
export function findAlias(
  countryId: string,
  cityName: string,
  nameNormalized: string,
): VenueAlias | null {
  if (!nameNormalized) return null;
  return (
    VENUE_ALIASES.find(
      (alias) =>
        alias.countryId === countryId &&
        alias.cityName === cityName &&
        alias.aliasNormalized === nameNormalized,
    ) ?? null
  );
}

/**
 * Registrable domains that host many unrelated venues' pages. Two records
 * sharing one of these is NOT evidence they are the same venue, so Tier 1
 * ignores it. Compared against the apex domain (e.g. "facebook.com").
 */
export const PLATFORM_HOSTS = new Set<string>([
  "facebook.com",
  "fb.com",
  "fb.me",
  "instagram.com",
  "instagr.am",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "linktr.ee",
  "linktree.com",
  "google.com",
  "goo.gl",
  "bit.ly",
  "blogspot.com",
  "t.me",
  "telegram.me",
  "linkedin.com",
  "wixsite.com",
  "wordpress.com",
]);

/**
 * The apex (registrable) domain of a URL, lower-cased, or null if it can't be
 * parsed. Deliberately simple: the last two labels of the hostname
 * (foo.bar.example.com -> example.com). Multi-part public suffixes (co.uk) are
 * not special-cased; if that makes the result "wrong" it only ever makes the
 * Tier 1 domain check *more* conservative (it won't match), never less.
 */
export function apexDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  return labels.slice(-2).join(".");
}

/**
 * True when two URLs resolve to the same apex domain AND that domain is not a
 * known platform host — i.e. a dedicated venue website shared by both records.
 */
export function sameDedicatedDomain(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const domainA = apexDomain(a);
  const domainB = apexDomain(b);
  if (!domainA || !domainB) return false;
  if (domainA !== domainB) return false;
  return !PLATFORM_HOSTS.has(domainA);
}
