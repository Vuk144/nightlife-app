/**
 * `../src/aliases.ts` — curated venue-matching data + URL helpers used by the
 * deterministic matcher (`../src/matching.ts`, Tier 1 website identity and
 * Tier 3 curated alias).
 *
 * Characterization of the CURRENT contract. One `[KNOWN BUG]` block pins a
 * confirmed defect (compound-ccTLD apex collision) so the eventual fix flips it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apexDomain,
  findAlias,
  PLATFORM_HOSTS,
  sameDedicatedDomain,
  VENUE_ALIASES,
} from "../src/aliases.ts";
import { computeNameNormalized } from "../src/normalize.ts";

// ════════════════════════════════════════════════════════════════════════
//  findAlias
// ════════════════════════════════════════════════════════════════════════

test("[findAlias] resolves an exact (countryId, cityName, aliasNormalized) triple", () => {
  assert.equal(findAlias("RS", "Belgrade", "dragstor")?.canonicalName, "Drugstore");
  assert.equal(findAlias("RS", "Belgrade", "studenata tehnike")?.canonicalName, "KST");
});

test("[findAlias] every field is an EXACT, case-sensitive match — curated lookup, not fuzzy", () => {
  assert.equal(findAlias("rs", "Belgrade", "dragstor"), null); // country case
  assert.equal(findAlias("RS", "belgrade", "dragstor"), null); // city case
  assert.equal(findAlias("RS", "Belgrade", "Dragstor"), null); // alias case
  assert.equal(findAlias("RS", "Belgrade", " dragstor "), null); // no trimming
  assert.equal(findAlias("RS", "Novi Sad", "dragstor"), null); // different city
  assert.equal(findAlias("HR", "Belgrade", "dragstor"), null); // different country
});

test("[findAlias] empty / unknown name -> null (no throw)", () => {
  assert.equal(findAlias("RS", "Belgrade", ""), null);
  assert.equal(findAlias("RS", "Belgrade", "nothing curated here"), null);
});

test("[findAlias][latent] returns a LIVE reference into VENUE_ALIASES — callers must treat it read-only", () => {
  const a = findAlias("RS", "Belgrade", "dragstor")!;
  assert.equal(VENUE_ALIASES.includes(a), true);
  // matching.ts / venue-resolve.ts only READ `.canonicalName` / null-check it,
  // so the shared reference is safe today. A future mutating caller would
  // corrupt the module-level table.
});

test("[findAlias][coupling] alias strings must equal computeNameNormalized() of the real-world spelling", () => {
  // entry 1: OSM Cyrillic phonetic spelling
  assert.equal(computeNameNormalized("Драгстор"), "dragstor");
  // entry 2: the acronym's full Cyrillic form
  assert.equal(computeNameNormalized("Клуб студената технике"), "studenata tehnike");
});

test("[findAlias][dead-data] the 'klub studenata tehnike' entry is unreachable via computeNameNormalized (it strips 'klub')", () => {
  // computeNameNormalized drops the 'klub' stopword when other tokens survive,
  // so an incoming name_normalized can never be "klub studenata tehnike".
  assert.equal(computeNameNormalized("Klub studenata tehnike"), "studenata tehnike");
  assert.equal(computeNameNormalized("Клуб студената технике"), "studenata tehnike");
  const entry3 = VENUE_ALIASES.find((a) => a.aliasNormalized === "klub studenata tehnike");
  assert.ok(entry3, "the entry exists in the table…");
  assert.equal(
    VENUE_ALIASES.some((a) => a.aliasNormalized === computeNameNormalized("Klub studenata tehnike") && a === entry3),
    false,
    "…but nothing the normalizer produces ever selects it — harmless dead curation data",
  );
});

// ════════════════════════════════════════════════════════════════════════
//  apexDomain
// ════════════════════════════════════════════════════════════════════════

test("[apexDomain] nullish / empty / whitespace / unparseable -> null", () => {
  for (const v of [null, undefined, "", "   ", "\t", "not a url", "//example.com", "example.com", "http://", "javascript:alert(1)"]) {
    assert.equal(apexDomain(v as string | null | undefined), null, JSON.stringify(v));
  }
});

test("[apexDomain] a valid http/https URL -> lower-cased last two hostname labels", () => {
  assert.equal(apexDomain("https://example.com"), "example.com");
  assert.equal(apexDomain("http://EXAMPLE.COM/Path?q=1#frag"), "example.com");
  assert.equal(apexDomain("https://user:pass@example.com:8443/x"), "example.com");
  assert.equal(apexDomain("https://example.com."), "example.com"); // trailing dot dropped
  assert.equal(apexDomain("ftp://example.com"), "example.com"); // any scheme URL parses
});

test("[apexDomain] strips a leading 'www.' and collapses subdomains to the apex", () => {
  assert.equal(apexDomain("https://www.example.com"), "example.com");
  assert.equal(apexDomain("https://shop.venue.example.com"), "example.com");
  assert.equal(apexDomain("https://WWW.Venue.RS"), "venue.rs");
});

test("[apexDomain] fewer than two labels -> null (localhost, single-label, IPv6)", () => {
  assert.equal(apexDomain("http://localhost"), null);
  assert.equal(apexDomain("http://localhost:3000/x"), null);
  assert.equal(apexDomain("http://intranet"), null);
  assert.equal(apexDomain("http://[::1]"), null);
  assert.equal(apexDomain("http://[2001:db8::1]/x"), null);
});

test("[apexDomain] IDN hostnames are returned punycoded (deterministic, matches itself)", () => {
  const a = apexDomain("https://münchen.de");
  assert.equal(a, "xn--mnchen-3ya.de");
  assert.equal(apexDomain("https://xn--mnchen-3ya.de/events"), a);
});

test("[apexDomain][characterization] a scheme-less bare domain is NOT parsed -> null (the Tier 1 check simply skips it)", () => {
  assert.equal(apexDomain("drugstore.rs"), null);
  assert.equal(apexDomain("www.drugstore.rs/events"), null);
});

// ════════════════════════════════════════════════════════════════════════
//  sameDedicatedDomain
// ════════════════════════════════════════════════════════════════════════

test("[sameDedicatedDomain] same registrable domain across www / scheme / case / path -> true", () => {
  assert.equal(sameDedicatedDomain("https://www.drugstore.rs/", "http://drugstore.rs/events"), true);
  assert.equal(sameDedicatedDomain("https://DRUGSTORE.rs", "https://drugstore.RS/x"), true);
  assert.equal(sameDedicatedDomain("https://shop.venue.com", "https://www.venue.com"), true); // same org
});

test("[sameDedicatedDomain] different domains -> false", () => {
  assert.equal(sameDedicatedDomain("https://a.rs", "https://b.rs"), false);
  assert.equal(sameDedicatedDomain("https://venue.rs", "https://venue.com"), false);
});

test("[sameDedicatedDomain] a shared PLATFORM host is never venue identity", () => {
  assert.equal(sameDedicatedDomain("https://facebook.com/venue-a", "https://facebook.com/venue-b"), false);
  assert.equal(sameDedicatedDomain("https://a.blogspot.com", "https://b.blogspot.com"), false);
  assert.equal(sameDedicatedDomain("https://a.wixsite.com/x", "https://b.wixsite.com/y"), false);
  assert.equal(sameDedicatedDomain("https://linktr.ee/a", "https://linktr.ee/b"), false);
});

test("[sameDedicatedDomain] null / empty / unparseable on either side -> false", () => {
  assert.equal(sameDedicatedDomain(null, "https://x.com"), false);
  assert.equal(sameDedicatedDomain("https://x.com", null), false);
  assert.equal(sameDedicatedDomain(null, null), false);
  assert.equal(sameDedicatedDomain("", "https://x.com"), false);
  assert.equal(sameDedicatedDomain("not a url", "also not a url"), false);
  assert.equal(sameDedicatedDomain("drugstore.rs", "https://drugstore.rs"), false); // scheme-less side -> null
});

test("[sameDedicatedDomain] symmetric", () => {
  const pairs: Array<[string, string]> = [
    ["https://www.a.com", "https://a.com"],
    ["https://a.com", "https://b.com"],
    ["https://facebook.com/a", "https://facebook.com/b"],
  ];
  for (const [x, y] of pairs) {
    assert.equal(sameDedicatedDomain(x, y), sameDedicatedDomain(y, x), `${x} / ${y}`);
  }
});

// ════════════════════════════════════════════════════════════════════════
//  PLATFORM_HOSTS
// ════════════════════════════════════════════════════════════════════════

test("[PLATFORM_HOSTS] every entry is a 2-label apex that apexDomain can actually produce", () => {
  for (const host of PLATFORM_HOSTS) {
    assert.equal(host, host.toLowerCase(), `${host} is lower-cased`);
    assert.equal(host.split(".").filter(Boolean).length, 2, `${host} is exactly two labels`);
    // a URL on that host (or a subdomain of it) must fold back to the entry
    assert.equal(apexDomain(`https://${host}/x`), host);
    assert.equal(apexDomain(`https://sub.${host}/x`), host);
  }
});

// ════════════════════════════════════════════════════════════════════════
//  Compound public suffixes — regression for the apex-collision bug fixed in
//  the aliases.ts audit. `.com.hr` / `.com.rs` / `.co.rs` / `.org.rs` /
//  `.edu.rs` / `.in.rs` are real second-level domains in the deployment
//  geography; two unrelated registrants on one of them must NOT be treated as
//  sharing a dedicated venue domain.
// ════════════════════════════════════════════════════════════════════════

test("[compound-suffix] a curated compound ccTLD keeps the registrant label; unrelated registrants stay distinct", () => {
  assert.equal(apexDomain("https://tvornica.com.hr"), "tvornica.com.hr");
  assert.equal(apexDomain("https://mocvara.com.hr"), "mocvara.com.hr");
  assert.equal(apexDomain("https://klub-a.co.rs"), "klub-a.co.rs");
  assert.equal(apexDomain("https://klub-b.co.rs"), "klub-b.co.rs");

  // the false Tier 1 merge is gone
  assert.equal(sameDedicatedDomain("https://tvornica.com.hr", "https://mocvara.com.hr"), false);
  assert.equal(sameDedicatedDomain("https://klub-a.co.rs", "https://klub-b.co.rs"), false);

  // …the SAME registrable domain (www / subdomain / scheme) still matches
  assert.equal(sameDedicatedDomain("https://www.tvornica.com.hr/x", "http://tvornica.com.hr"), true);
  assert.equal(sameDedicatedDomain("https://shop.tvornica.com.hr", "https://tvornica.com.hr"), true);

  // a plain single-label ccTLD was always fine and is unchanged
  assert.equal(sameDedicatedDomain("https://tvornica.hr", "https://mocvara.hr"), false);
});

test("[compound-suffix] every curated entry: registrant kept whole, unrelated registrants distinct, same registrant matches", () => {
  for (const suffix of ["com.hr", "com.rs", "co.rs", "org.rs", "edu.rs", "in.rs"]) {
    assert.equal(apexDomain(`https://venue-one.${suffix}`), `venue-one.${suffix}`, suffix);
    assert.equal(apexDomain(`https://sub.venue-one.${suffix}`), `venue-one.${suffix}`, `sub.${suffix}`);
    assert.equal(
      sameDedicatedDomain(`https://venue-one.${suffix}`, `https://venue-two.${suffix}`),
      false,
      `unrelated registrants on ${suffix} must not merge`,
    );
    assert.equal(
      sameDedicatedDomain(`https://www.venue-one.${suffix}`, `https://venue-one.${suffix}/events`),
      true,
      `same registrant on ${suffix} still matches`,
    );
  }
});

test("[compound-suffix] a compound suffix NOT in the curated set is deliberately unchanged (still last two labels)", () => {
  // co.uk / com.au etc. are not onboarded — behaviour is intentionally left
  // exactly as it was: everything under such a suffix collapses to the suffix
  // itself, so two different registrants sharing it still over-match. Documented
  // gap; add the suffix to COMPOUND_SUFFIXES when that country is onboarded.
  assert.equal(apexDomain("https://a.example.co.uk"), "co.uk");
  assert.equal(apexDomain("https://pub-a.co.uk"), "co.uk");
  assert.equal(apexDomain("https://pub-b.co.uk"), "co.uk");
  assert.equal(sameDedicatedDomain("https://pub-a.co.uk", "https://pub-b.co.uk"), true);
});

test("[compound-suffix] a bare 2-label compound suffix host has no registrant label -> left as-is", () => {
  // only 2 labels, so the `labels.length >= 3` guard does not fire
  assert.equal(apexDomain("https://com.hr"), "com.hr");
});

test("[latent] a raw IPv4 website still yields a nonsense 2-label 'apex' (out of scope for this fix; raw IPs are not venue websites)", () => {
  assert.equal(apexDomain("http://127.0.0.1/venue"), "0.1");
  assert.equal(sameDedicatedDomain("http://127.0.0.1/a", "http://127.0.0.1/b"), true);
});
