/**
 * Contract characterization tests for the shared event-ingestion text helpers
 * (`../../src/events/text.ts`). Locks the documented behavior — Serbian Latin
 * folding, the entity set that actually occurs in GIGS TIX pages, the
 * strip-then-decode order, determinism and empty-string safety — since the
 * helpers had no direct test coverage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockText,
  collapseWs,
  decodeEntities,
  inlineText,
  sha1,
  stripTags,
  tokenize,
} from "../../src/events/text.ts";

// ── tokenize ───────────────────────────────────────────────────────
test("tokenize: folds Serbian Latin diacritics (č/ć->c, š->s, ž->z, đ->dj)", () => {
  assert.deepEqual(tokenize("Stranica nije pronađena"), ["stranica", "nije", "pronadjena"]);
  assert.deepEqual(tokenize("Srđana Dinčića"), ["srdjana", "dincica"]);
  assert.deepEqual(tokenize("međunarodni supercar show"), ["medjunarodni", "supercar", "show"]);
  assert.deepEqual(tokenize("Đorđe Balašević"), ["djordje", "balasevic"]);
});

test("tokenize: NFC and NFD spellings of the same word produce identical tokens", () => {
  assert.deepEqual(tokenize("ćupš"), tokenize("ćupš"));
  assert.deepEqual(tokenize("café"), tokenize("café"));
});

test("tokenize: digits kept, separators collapsed, empty/whitespace -> []", () => {
  assert.deepEqual(tokenize("Sala 3 — b2b set, 2026!"), ["sala", "3", "b2b", "set", "2026"]);
  assert.deepEqual(tokenize("a   --   b"), ["a", "b"]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("   \t\n  "), []);
});

test("tokenize: Latin-only — Cyrillic text yields no tokens (documented scope)", () => {
  assert.deepEqual(tokenize("Концерт Бајаге"), []);
});

test("tokenize: deterministic and does not depend on host locale", () => {
  const input = "PREMIJERA: „Katran i perje“ — DJ set uživo";
  assert.deepEqual(tokenize(input), tokenize(input));
  assert.deepEqual(tokenize(input), ["premijera", "katran", "i", "perje", "dj", "set", "uzivo"]);
});

// ── decodeEntities ─────────────────────────────────────────────────
test("decodeEntities: the entities that actually occur in GIGS TIX pages", () => {
  assert.equal(
    decodeEntities("StandUpFest &#8211; &quot;Katran i perje&quot; &#8222;X&#8220; &amp; More"),
    "StandUpFest – \"Katran i perje\" „X“ & More",
  );
  assert.equal(decodeEntities("&#x2019;&#8217;"), "’’");
  assert.equal(decodeEntities("&hellip;&mdash;&ndash;"), "…—–");
});

test("decodeEntities: single pass only — WordPress double-escaping is preserved as text", () => {
  assert.equal(decodeEntities("&amp;amp;"), "&amp;");
  assert.equal(decodeEntities("&amp;nbsp;"), "&nbsp;");
});

test("decodeEntities: leaves non-entity ampersands and unknown names untouched", () => {
  assert.equal(decodeEntities("Tom & Jerry"), "Tom & Jerry");
  assert.equal(decodeEntities("R&D and A&B"), "R&D and A&B");
  assert.equal(decodeEntities("cena &euro; 10"), "cena &euro; 10");
});

test("decodeEntities: malformed / out-of-range numeric entities never throw", () => {
  assert.doesNotThrow(() => decodeEntities("x&#x110000;y&#99999999999;z&#0;"));
  assert.equal(decodeEntities("a&#x1F525;b"), "a🔥b"); // valid astral codepoint
  assert.equal(decodeEntities(""), "");
});

// ── stripTags / collapseWs / inlineText ────────────────────────────
test("stripTags: every tag becomes a space; entities are NOT decoded here", () => {
  assert.equal(stripTags("<p>a</p><b>b</b>"), " a  b ");
  assert.equal(stripTags("x &amp; y"), "x &amp; y");
  assert.equal(stripTags(""), "");
});

test("inlineText: strips tags THEN decodes — an escaped tag survives as literal text", () => {
  assert.equal(inlineText("&lt;b&gt;keep me&lt;/b&gt;"), "<b>keep me</b>");
  assert.equal(inlineText("<div>Datum&nbsp;i&nbsp;vreme</div>"), "Datum i vreme");
  assert.equal(inlineText("  <span> a  b </span>  "), "a b");
  assert.equal(inlineText(""), "");
});

test("collapseWs: collapses every whitespace run (incl. NBSP) and trims", () => {
  assert.equal(collapseWs("  a \t b \n c  "), "a b c");
  assert.equal(collapseWs(""), "");
});

// ── blockText ──────────────────────────────────────────────────────
test("blockText: <br>, </p>, </li>, </hN> become line breaks; inline tags do not", () => {
  assert.equal(blockText("<p>A<br>B</p><p>C</p>"), "A\nB\nC");
  assert.equal(blockText("<ul><li>one</li><li>two</li></ul>"), "one\ntwo");
  assert.equal(blockText("<h2>Title</h2><p>Body <strong>bold</strong> end</p>"), "Title\nBody bold end");
  assert.equal(blockText("<BR/><Br /><br>"), "");
});

test("blockText: decodes entities after stripping and drops blank lines", () => {
  assert.equal(
    blockText("<p>“Live in Belgrade” &amp; more</p>\n\n<p>  </p>\n<p>next</p>"),
    "“Live in Belgrade” & more\nnext",
  );
  assert.equal(blockText(""), "");
});

// ── sha1 ───────────────────────────────────────────────────────────
test("sha1: deterministic UTF-8 hex digest", () => {
  assert.equal(sha1(""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
  assert.equal(sha1("name:barutana bg|2026-07-01"), sha1("name:barutana bg|2026-07-01"));
  assert.equal(sha1("Дом омладине"), sha1("Дом омладине"));
  assert.match(sha1("x"), /^[0-9a-f]{40}$/);
});

// ── purity ─────────────────────────────────────────────────────────
test("all helpers are pure — repeated calls are identical, no throw on empty input", () => {
  for (const fn of [decodeEntities, stripTags, collapseWs, inlineText, blockText]) {
    assert.equal(fn(""), fn(""));
    assert.doesNotThrow(() => fn(""));
  }
  assert.deepEqual(tokenize(""), tokenize(""));
});
