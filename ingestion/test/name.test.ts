/**
 * Characterization of the identity/normalization leaf module (`../src/name.ts`).
 *
 * `normalizeName` / `computeNameNormalized` output feeds `venues.name_normalized`
 * persistence, Tier 2 venue matching, the rescue alias set, and duplicate
 * prevention — so its collapse behavior IS the product's dedup policy. These
 * tests pin that behavior; `[regression]` marks the capital-eth / capital-sharp-s
 * fix; `[latent]` marks documented gaps left unchanged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName, computeNameNormalized } from "../src/name.ts";

const N = normalizeName;
const C = computeNameNormalized;

function table(label: string, cases: [input: string, expected: string][]): void {
  test(label, () => {
    for (const [input, expected] of cases) {
      assert.equal(N(input), expected, `normalizeName(${JSON.stringify(input)})`);
    }
  });
}

// ── Serbian Cyrillic -> Latin (all 30 letters, both cases) ───────────

table("[cyrillic] every Serbian Cyrillic letter transliterates (upper-case via the lower-case pass)", [
  ["абвгд", "abvgd"],
  ["ђежзи", "djezzi"],
  ["јклљм", "jklljm"],
  ["нњопр", "nnjopr"],
  ["стћуф", "stcuf"],
  ["хцчџш", "hccdzs"],
  ["ЂОЛЕ", "djole"],
  ["ЊЕГОШ", "njegos"],
  ["Џекпот", "dzekpot"],
  ["ЋИРА Чачак ШАБАЦ", "cira cacak sabac"],
  ["Кафана Њу Јорк", "kafana nju jork"],
]);

table("[cyrillic] precomposed non-Serbian Cyrillic decomposes via NFKD (й -> и, ё -> е)", [
  ["Йорк", "iork"],   // й = и + U+0306 breve -> stripped -> и -> i
  ["Ёлка", "elka"],   // ё = е + U+0308 -> е -> e
]);

// ── Latin diacritics ────────────────────────────────────────────────

table("[latin] Serbian Latin diacritics fold to their base letter", [
  ["čćšžđ", "ccszd"],
  ["ČĆŠŽĐ", "ccszd"],
  ["Kafana Šešir", "kafana sesir"],
  ["Ćevabdžinica", "cevabdzinica"],
  ["Žabac", "zabac"],
  ["Đeram", "deram"],       // U+0110 Đ  (already worked)
]);

// ── LATIN_SPECIAL: every entry, BOTH cases ──────────────────────────

table("[special] non-decomposable Latin letters map in upper and lower case", [
  ["đ Đ", "d d"],
  ["ø Ø", "o o"],
  ["ł Ł", "l l"],
  ["æ Æ", "ae ae"],
  ["œ Œ", "oe oe"],
  ["ß", "ss"],
  ["Straße", "strasse"],
  ["Æther Øl Œuvre", "aether ol oeuvre"],
  ["Łódź", "lodz"],
]);

test("[regression] capital eth Ð (U+00D0) and capital sharp-s ẞ (U+1E9E) map like their lower-case forms", () => {
  // Before the fix LATIN_SPECIAL had only the lower-case 'ð' / 'ß'. Because the
  // map runs BEFORE lower-casing, an upper-case 'Ð' / 'ẞ' fell straight through
  // to the `[^a-z0-9]` step and was DELETED — losing a letter and breaking
  // case-symmetry.
  //
  // Concrete failure: an OSM element mis-tagged "Ðeram" with U+00D0 (visually
  // identical to Serbian Đ / U+0110) normalized to "eram", so Tier 2 could not
  // match the existing "Đeram" venue (name_normalized "deram") and dedup
  // silently inserted a duplicate.
  assert.equal(N("Ðeram"), "deram");      // U+00D0  — was "eram"
  assert.equal(N("Đeram"), "deram");      // U+0110  — unchanged
  assert.equal(N("ðeram"), "deram");      // U+00F0  — unchanged
  assert.equal(N("Ð") === N("ð"), true);
  assert.equal(N("STRAẞE"), "strasse");   // U+1E9E  — was "stra e"
  assert.equal(N("Straße"), "strasse");   // unchanged
});

// ── NFKD combining-mark stripping ───────────────────────────────────

table("[nfkd] combining marks in U+0300-036F are stripped after decomposition", [
  ["Café", "cafe"],
  ["Piñata", "pinata"],
  ["é", "e"],                 // bare combining acute
  ["ﬀ", "ff"],                       // compatibility ligature (NFKD)
  ["①②③", "123"],                    // circled digits fold via NFKD
]);

// ── mixed script / Unicode whitespace / punctuation ────────────────

table("[mixed] Latin + Cyrillic in one name both fold to Latin", [
  ["Кафе Bar Москва", "kafe moskva"],
  ["Café Кафе", "cafe kafe"],
  ["Bar Пиво & Grill", "pivo grill"],
]);

table("[punct] Unicode spaces, dashes and punctuation collapse to single ASCII spaces", [
  ["A  B", "a b"],         // nbsp + thin space
  ["A—B–C", "a b c"],                // em / en dashes
  ["  R&B   Lounge  ", "r b lounge"],
  ["20/44", "20 44"],
  ["Restoran \"DOT\"", "restoran dot"],
]);

table("[symbols] emoji / symbol / non-Latin-script-only input normalizes to empty", [
  ["🎉🍸", ""],
  ["!!! ??? ***", ""],
  ["北京", ""],
  ["Θέατρο", ""],
]);

// ── stopwords: whole-token only, keep-at-least-one ─────────────────

table("[stopwords] the / club / klub / bar are dropped only as whole tokens", [
  ["Klub Drugstore", "drugstore"],
  ["Drugstore Club", "drugstore"],
  ["The Tube", "tube"],
  ["Bar Central", "central"],
  ["Barbarella", "barbarella"],        // substring — NOT stripped
  ["Clubhouse", "clubhouse"],
  ["Barista", "barista"],
  ["Klub Klub Drugstore", "drugstore"],// repeated stopword
]);

table("[stopwords] a name made only of stopwords keeps every token (never empties)", [
  ["The Club", "the club"],
  ["Club Bar", "club bar"],
  ["Bar", "bar"],
  ["The", "the"],
  ["Bar The Club Klub", "bar the club klub"],
]);

// ── city words: leading / trailing only, keep-at-least-one ─────────

table("[city] beograd / belgrade stripped from the ends only", [
  ["Drugstore Beograd", "drugstore"],
  ["Belgrade Drugstore", "drugstore"],
  ["Belgrade Belgrade Tube", "tube"],
  ["Tube Belgrade Belgrade", "tube"],
  ["Klub Beograd Tube", "beograd tube"],   // middle city word stays
  ["Belgrade", "belgrade"],                // only a city word -> kept
  ["Beograd Beograd", "beograd"],          // keep one
]);

// ── identity collisions (INTENTIONAL canonicalization) ────────────

test("[collision] category words collapse 'Bar X' / 'Club X' / 'The X' / 'X Belgrade' -> 'x' (documented dedup policy)", () => {
  for (const s of ["Bar X", "Club X", "Klub X", "X Bar", "X Club", "The X", "X Belgrade", "Belgrade X"]) {
    assert.equal(N(s), "x", s);
  }
  // Tier 2 guards this: it merges only when EXACTLY ONE existing row matches in
  // the same city; 2+ -> skip. Short residual keys ("k" from "K Bar" / "K Klub")
  // are a known acceptable risk of the tiny 4-word stopword set, not a bug.
  assert.equal(N("K Bar"), "k");
  assert.equal(N("K Klub"), "k");
});

// ── empty / fallback semantics ──────────────────────────────────────

test("[empty] normalizeName may return '' (callers must not match on it)", () => {
  assert.equal(N(""), "");
  assert.equal(N("   "), "");
  assert.equal(N("🎉"), "");
});

test("[empty][latent] computeNameNormalized still returns '' for empty / whitespace-only input", () => {
  // The docstring promises name_normalized "never ''". That holds for every
  // input the pipeline can actually produce (resolveName trims and rejects
  // blank names; venues.name is NOT NULL and seeded non-blank), and every
  // consumer treats a falsy key as "no key" (`if (incoming.nameNormalized)`,
  // rescue's `.filter(Boolean)`), so a '' here cannot cause a false merge.
  // Pinned; a non-empty sentinel would DEFEAT those guards, so left unchanged.
  assert.equal(C(""), "");
  assert.equal(C("   "), "");
  assert.equal(C("\t\n"), "");
});

test("[fallback] computeNameNormalized keeps the original when normalization empties a real name", () => {
  assert.equal(C("🎉"), "🎉");
  assert.equal(C("!!!"), "!!!");
  assert.equal(C("北京"), "北京");
  assert.equal(C("  Bar  "), "bar");           // normal path still wins
  assert.equal(C("The Club"), "the club");
});

// ── object / lookup safety (prototype keys) ────────────────────────

test("[proto] dangerous property names as venue tokens never leak Object.prototype values", () => {
  // ch is always a single code point, so LATIN_SPECIAL[ch] / CYRILLIC_TO_LATIN[ch]
  // cannot hit a multi-char prototype key; STOPWORDS/CITY_WORDS are Sets (.has).
  assert.equal(N("__proto__ Bar"), "proto");
  assert.equal(N("constructor"), "constructor");
  assert.equal(N("toString hasOwnProperty valueOf"), "tostring hasownproperty valueof");
  assert.equal(C("__proto__"), "proto");
  assert.equal(typeof N("prototype"), "string");
});

// ── determinism / purity ───────────────────────────────────────────

test("[purity] repeated calls are identical, including after unusual inputs", () => {
  N("🎉");
  N("北京");
  N("Красный");
  assert.equal(N("Kafana Šešir"), "kafana sesir");
  assert.equal(N("Kafana Šešir"), N("Kafana Šešir"));
  const s = "  ĐАВО   Club  ";
  assert.equal(N(s), N(s));
});

// ── computeNameNormalized vs the inline copy in normalize.ts ───────

test("[consistency] computeNameNormalized matches normalize.ts's inline fallback expression on a sample", () => {
  // normalize.ts line ~114 re-inlines `normalizeName(name) || name.toLowerCase()
  // .replace(/\s+/g," ").trim()` instead of calling this helper. Verify the two
  // agree so a persisted key equals a freshly matched key. (Any real divergence
  // is a normalize.ts concern — flagged for that audit, not fixed here.)
  const inline = (name: string): string =>
    normalizeName(name) || name.toLowerCase().replace(/\s+/g, " ").trim();
  for (const s of ["Drugstore", "Klub DOT", "Кафе Москва", "🎉", "  ", "Bar Central", ""]) {
    assert.equal(C(s), inline(s), s);
  }
});
