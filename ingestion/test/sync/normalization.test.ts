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
