/**
 * `../../src/sync/normalization.ts` — per-country name normalization profiles.
 *
 * Guards: determinism, source-agnostic purity, Unicode/diacritic folding for
 * Serbian/Croatian/Bosnian Latin letters, separator handling, idempotence,
 * null/empty behaviour, no locale-specific logic leaking into the generic
 * (`latin`) profile, and that distinct identities are not accidentally
 * collapsed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { latinProfile, serbianProfile, profileFor } from "../../src/sync/normalization.ts";
import { computeNameNormalized } from "../../src/name.ts";
import type { CountryConfig } from "../../src/sync/config.ts";

const N = (raw: string): string => latinProfile.normalizeName(raw);
const S = (raw: string): string => serbianProfile.normalizeName(raw);

function country(over: Partial<CountryConfig> = {}): CountryConfig {
  return {
    code: "HR",
    name: "Croatia",
    enabled: true,
    defaultTimeZone: "Europe/Zagreb",
    bounds: null,
    normalizationProfile: "latin",
    extraPlaceholderPatterns: [],
    ...over,
  };
}

// ── 1. deterministic + source-agnostic ─────────────────────────────
test("normalization is deterministic — same input, same output, every call", () => {
  for (const raw of ["Klub Močvara", "R&B / Lounge", "  DJ  Night  "]) {
    const first = N(raw);
    for (let i = 0; i < 5; i++) assert.equal(N(raw), first);
  }
});

test("normalization depends ONLY on the string (two identical strings normalize identically)", () => {
  // whatever their provenance, identical bytes → identical key
  assert.equal(N("Tvornica Kulture"), N("Tvornica Kulture"));
  assert.equal(S("Дом Омладине"), S("Дом Омладине"));
});

// ── 2. Unicode / BCS Latin letters ─────────────────────────────────
test("latin profile folds the five Serbian/Croatian/Bosnian Latin letters (both cases)", () => {
  assert.equal(N("čćđšž"), "ccdjsz"); // đ → dj in the script-neutral profile
  assert.equal(N("ČĆĐŠŽ"), "ccdjsz");
  assert.equal(N("Čačak"), "cacak");
  assert.equal(N("Šibenik"), "sibenik");
  assert.equal(N("Žnjan"), "znjan");
  assert.equal(N("Đakovo"), "djakovo");
  assert.equal(N("Ćoškica"), "coskica");
});

test("serbian profile folds the same letters via its curated map (đ → d)", () => {
  assert.equal(S("Đakovo"), "dakovo");
  assert.equal(S("Šešir"), "sesir");
  assert.equal(S("Žnjan"), "znjan");
});

test("latin profile: NFC and NFD spellings of the same name normalize identically", () => {
  const nfc = "Kafić Šešir".normalize("NFC");
  const nfd = "Kafić Šešir".normalize("NFD");
  assert.notEqual(nfc, nfd, "the two Unicode forms are different strings");
  assert.equal(N(nfc), N(nfd));
  assert.equal(N(nfc), "kafic sesir");
});

test("latin profile: non-decomposable Latin letters (ø ł ß æ œ) are transliterated, not dropped", () => {
  assert.equal(N("Smørrebrød"), "smorrebrod");
  assert.equal(N("Łódź"), "lodz");
  assert.equal(N("Straße"), "strasse");
  assert.equal(N("Æther"), "aether");
  assert.equal(N("Cœur"), "coeur");
});

test("latin profile: German/Hungarian vowels fold to their base letter", () => {
  assert.equal(N("Grüner Jäger"), "gruner jager");
  assert.equal(N("Bögötő"), "bogoto"); // Hungarian double-acute ő
});

test("serbian profile still transliterates Cyrillic", () => {
  assert.equal(S("Дрогстор"), "drogstor");
  assert.equal(S("Кафана Šešir"), "kafana sesir"); // mixed-script
});

// ── 3. separators: whitespace / punctuation / case / ' - / & repeats ─
test("latin profile: case fold, and every non-alphanumeric run becomes ONE space", () => {
  assert.equal(N("DRUGSTORE"), "drugstore");
  assert.equal(N("  Kafana   Šešir  "), "kafana sesir");
  assert.equal(N("R&B Lounge"), "r b lounge");
  assert.equal(N("AC/DC Tribute"), "ac dc tribute");
  assert.equal(N("20/44"), "20 44");
  assert.equal(N("O'Brien's"), "o brien s");
  assert.equal(N("Rock — Pop – Jazz"), "rock pop jazz"); // em/en dashes
  assert.equal(N("A  --  B"), "a b"); // repeated separators collapse
  assert.equal(N("Klub „Underground“"), "klub underground"); // typographic quotes
  assert.equal(N("Café’s"), "cafe s"); // U+2019 typographic apostrophe
});

test("latin profile: a name that is only separators / symbols normalizes to empty", () => {
  for (const raw of ["", "   ", "!!!", "—", " & / - ", "\t\n"]) {
    assert.equal(N(raw), "", JSON.stringify(raw));
  }
});

// ── 4. does NOT accidentally collapse distinct identities ──────────
test("distinct names stay distinct after normalization", () => {
  assert.notEqual(N("Foo Bar"), N("Foobar")); // "foo bar" vs "foobar"
  assert.notEqual(N("Studio 6"), N("Studio 9"));
  assert.notEqual(N("Depo"), N("Depot"));
  assert.notEqual(N("Klub A"), N("Klub B"));
  assert.notEqual(N("Bass"), N("Base")); // ss vs se — not folded together
});

test("equivalent spellings DO collapse (that is the point)", () => {
  assert.equal(N("Café"), N("Cafe"));
  assert.equal(N("Café"), N("CAFÉ"));
  assert.equal(N("Kafić  Šešir"), N("kafic sesir"));
});

// ── 5. appropriate for venue names AND event titles ───────────────
test("the same profile normalizes a venue name and an event title the same way", () => {
  // event-title-shaped input goes through the identical code path
  assert.equal(N("Boris Brejcha — Live @ Tvornica"), "boris brejcha live tvornica");
  assert.equal(N("New Year's Eve 2027"), "new year s eve 2027");
});

// ── 6. no locale-specific logic in the GENERIC (latin) profile ────
test("latin profile does NOT strip stopwords or city words (that is sr-only)", () => {
  assert.equal(N("The Club"), "the club");
  assert.equal(N("Klub Tvornica"), "klub tvornica");
  assert.equal(N("Bar Central"), "bar central");
  assert.equal(N("Drugstore Beograd"), "drugstore beograd");
  assert.equal(N("Drugstore Belgrade"), "drugstore belgrade");
});

test("serbian profile DOES strip its curated stopwords / city words", () => {
  assert.equal(S("Klub Drugstore"), "drugstore");
  assert.equal(S("Drugstore Beograd"), "drugstore");
  assert.equal(S("The Tube"), "tube");
});

// ── 7. idempotence ────────────────────────────────────────────────
test("normalizing an already-normalized value is a fixed point (both profiles)", () => {
  const inputs = [
    "Klub Močvara",
    "R&B / Lounge",
    "  Multiple   Spaces  ",
    "Đakovo",
    "Straße 45",
    "The Club",
    "!!!",
    "Boris Brejcha — Live @ Tvornica",
    "Дрогстор",
  ];
  for (const raw of inputs) {
    const once = N(raw);
    assert.equal(N(once), once, `latin not idempotent: ${JSON.stringify(raw)} → ${JSON.stringify(once)}`);
    const onceS = S(raw);
    assert.equal(S(onceS), onceS, `sr not idempotent: ${JSON.stringify(raw)} → ${JSON.stringify(onceS)}`);
  }
});

// ── 8. empty / null / very short ──────────────────────────────────
test("both profiles are null-safe: a nullish name normalizes to '' and never throws", () => {
  for (const bad of [null, undefined]) {
    assert.equal(latinProfile.normalizeName(bad as unknown as string), "");
    assert.equal(serbianProfile.normalizeName(bad as unknown as string), "");
  }
});

test("empty / whitespace / single-character inputs behave as intended", () => {
  assert.equal(N(""), "");
  assert.equal(N("   "), "");
  assert.equal(N("a"), "a");
  assert.equal(N("Ž"), "z");
  assert.equal(N("1"), "1");
  assert.equal(S(""), "");
  assert.equal(S("a"), "a");
});

// ── 9. profileFor: data-driven selection, latin as the safe default ─
test("profileFor selects by CountryConfig.normalizationProfile, defaulting to latin", () => {
  assert.equal(profileFor(null).key, "latin");
  assert.equal(profileFor(country({ normalizationProfile: "latin" })).key, "latin");
  assert.equal(profileFor(country({ code: "RS", normalizationProfile: "sr" })).key, "sr");
  assert.equal(profileFor(country({ normalizationProfile: "does-not-exist" })).key, "latin");
  assert.equal(profileFor(country({ normalizationProfile: "" })).key, "latin");
});

test("profileFor returns a STABLE reference (the singleton profile, never a fresh object)", () => {
  assert.equal(profileFor(null), latinProfile);
  assert.equal(profileFor(country({ normalizationProfile: "latin" })), latinProfile);
  assert.equal(
    profileFor(country({ normalizationProfile: "latin" })),
    profileFor(country({ normalizationProfile: "latin" })),
  );
  assert.equal(profileFor(country({ code: "RS", normalizationProfile: "sr" })), serbianProfile);
});

test("profileFor does not mutate the CountryConfig it is handed", () => {
  const c = country({ normalizationProfile: "sr" });
  Object.freeze(c);
  assert.doesNotThrow(() => profileFor(c));
  assert.equal(c.normalizationProfile, "sr");
});

test("profileFor treats the profile key as exact-match: case and surrounding space are NOT normalized", () => {
  for (const key of ["SR", "Sr", "LATIN", "Latin", " sr", "sr ", " latin "]) {
    assert.equal(profileFor(country({ normalizationProfile: key })).key, "latin", JSON.stringify(key));
  }
});

// ── 9b. REGRESSION: profile key colliding with an Object.prototype member ──
test("profileFor: a key that names an Object.prototype member falls back to latin (not an inherited value)", () => {
  // `PROFILES` is an object literal, so a bare `PROFILES[key]` walks the
  // prototype chain: `PROFILES["toString"]` is a function, `PROFILES["__proto__"]`
  // is `Object.prototype`. Both are truthy, so `?? latinProfile` never fires and
  // the caller gets an object with no `normalizeName` — a crash deep in the
  // engine. The contract is "unknown key -> latinProfile"; these keys are unknown.
  for (const key of [
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "__proto__",
    "__defineGetter__",
  ]) {
    const p = profileFor(country({ normalizationProfile: key }));
    assert.equal(p, latinProfile, `key ${JSON.stringify(key)} must resolve to latinProfile`);
    assert.equal(typeof p.normalizeName, "function", `key ${JSON.stringify(key)}`);
    assert.equal(p.normalizeName("Tvornica Kulture"), "tvornica kulture");
  }
});

// ── 10. latinProfile: NFKD *compatibility* folding is deliberate ──────
test("latin profile applies NFKD compatibility mappings (ligatures / fractions / width / roman)", () => {
  assert.equal(N("ﬁx"), "fix"); // U+FB01 fi-ligature -> "fi"
  assert.equal(N("½ litre"), "1 2 litre"); // vulgar fraction -> "1 ⁄ 2"
  assert.equal(N("ＡＢ 12"), "ab 12"); // fullwidth Latin + fullwidth digits
  assert.equal(N("Sala Ⅳ"), "sala iv"); // U+2163 roman numeral (has a lowercase form)
  assert.equal(N("Nº 5"), "no 5"); // U+00BA masculine ordinal -> "o"
});

test("latin profile: a compat decomposition that yields UPPERCASE ascii is dropped (lower-case precedes NFKD)", () => {
  // Lower-casing runs before NFKD, so "™" -> NFKD "TM" arrives after the
  // case-fold and is stripped by [^a-z0-9]. This is self-consistent and
  // idempotent; documented so the ordering is not "fixed" by accident.
  assert.equal(N("Café™"), "cafe");
  assert.equal(N("Studio ℠"), "studio");
  assert.equal(N(N("Café™")), N("Café™")); // still idempotent
});

test("[recall gap, shared with ../name.ts] eth and thorn are NOT in latinProfile's map — they drop to a space", () => {
  // `đ ø ł ß æ œ` are transliterated; `ð` (eth) and `þ` (thorn) are not, so they
  // become separators. No configured country needs Icelandic/Faroese/OE text;
  // `../name.ts` has the identical gap. Characterized, not fixed.
  assert.equal(N("Ðorđe"), "ordje"); // eth dropped, đ -> dj kept
  assert.equal(N("Þór"), "or");
});

// ── 11. Serbian profile === ../name.ts#computeNameNormalized (the real fn) ──
test("serbianProfile.normalizeName is byte-for-byte computeNameNormalized for every real string", () => {
  const matrix = [
    // Serbian Latin
    "Kafana Šešir", "Đeram", "Klub Drugstore", "Drugstore Club", "KC Grad",
    "Čačak", "Žnjan", "Ćoškica", "Njegoševa 19",
    // Serbian Cyrillic
    "Дом Омладине", "Дрогстор", "Клуб Бироскоп", "Београд", "Нови Сад",
    // mixed script
    "Кафана Šešir", "DJ Krmak uživo u Beogradu",
    // venue-ish punctuation / digits
    "20/44", "R&B / Lounge", "  Klub   Fest  ", "Boom Boom Room!!!", "1 A",
    // city-name variants
    "Novi Sad", "Beograd", "Belgrade",
    // degenerate / stopword-only / short
    "", "   ", "!!!", "the club", "The", "a", "Klub", "Bar",
    // Unicode forms
    "Kafić Šešir".normalize("NFC"), "Kafić Šešir".normalize("NFD"),
  ];
  for (const raw of matrix) {
    assert.equal(
      serbianProfile.normalizeName(raw),
      computeNameNormalized(raw),
      `divergence for ${JSON.stringify(raw)}`,
    );
  }
});

test("serbianProfile's ONLY divergence from computeNameNormalized is nullish-safety", () => {
  // computeNameNormalized itself throws on null — its non-empty fallback does
  // `name.toLowerCase()`. The wrapper's `?? ""` is the whole reason it exists.
  assert.throws(() => computeNameNormalized(null as unknown as string), TypeError);
  assert.equal(serbianProfile.normalizeName(null as unknown as string), "");
  assert.equal(serbianProfile.normalizeName(undefined as unknown as string), "");
});

test("serbianProfile inherits computeNameNormalized's non-empty fallback — it can differ from latin's ''", () => {
  // punctuation-only: latinProfile yields "", the Serbian profile keeps a
  // last-resort key (computeNameNormalized's documented "never ''" behaviour).
  assert.equal(latinProfile.normalizeName("!!!"), "");
  assert.equal(serbianProfile.normalizeName("!!!"), computeNameNormalized("!!!"));
  assert.notEqual(serbianProfile.normalizeName("!!!"), "");
});

// ── 12. empty normalized name is NOT coerced to a key by this module ──
test("latinProfile returns a bare '' for name-less input — it never invents a fallback key", () => {
  // The 'never match on "" ' rule is enforced by ./validation.ts (venue records
  // with an empty normalizedName are rejected), NOT patched over here.
  for (const raw of ["", "   ", "!!!", "—", "＠＃＄", "🎧🎶", "Београд"]) {
    assert.equal(latinProfile.normalizeName(raw), "", JSON.stringify(raw));
  }
});

// ── 13. cross-module: ingest-time key === match-time key ─────────────
test("for a latin country the SAME profile normalizes on ingest and on identity match (self-consistent)", () => {
  // engine.ts fills `normalizedName` with `profileFor(country).normalizeName`,
  // and matching.ts Tier 2 compares that stored value verbatim (no
  // re-normalization) — so the only thing that must hold is that the profile is
  // a pure function of the string, which it is.
  const hr = profileFor(country({ code: "HR", normalizationProfile: "latin" }));
  assert.equal(hr.normalizeName("Klub Đakovo"), hr.normalizeName("klub djakovo"));
  assert.equal(hr.normalizeName("Klub Đakovo"), "klub djakovo");
});

test("for Serbia the ingest profile and the events/dedup normalizer are the same function", () => {
  const rs = profileFor(country({ code: "RS", normalizationProfile: "sr" }));
  for (const raw of ["Дом Омладине", "Klub Drugstore Beograd", "KC Grad"]) {
    assert.equal(rs.normalizeName(raw), computeNameNormalized(raw));
  }
});
