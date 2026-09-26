/**
 * Invariants for the relevance keyword data (`../../src/events/relevance-keywords.ts`).
 *
 * These lock the intended relationships BETWEEN the curated sets — the things
 * `relevance.ts`'s decision tree silently assumes. They are not a re-statement
 * of the classifier's behavior (that is covered by `relevance.test.ts`); they
 * guard against a future edit that makes two lists contradict each other.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAT_FESTIVAL,
  CAT_GENERIC,
  CAT_MUSIC,
  CAT_NEWYEAR,
  CAT_SPORT,
  CAT_STANDUP,
  CAT_THEATRE,
  FESTIVAL_TOKENS,
  HARD_NEGATIVE,
  KIDS,
  MUSIC_STRONG,
  NIGHT_TOKENS,
  NIGHTLIFE_SECONDARY,
  NON_MUSIC_FESTIVAL,
} from "../../src/events/relevance-keywords.ts";

const intersection = (a: Set<string>, b: Set<string>): string[] =>
  [...a].filter((t) => b.has(t)).sort();

test("category slugs are the GIGS TIX eventcat-* values the classifier branches on", () => {
  assert.deepEqual(
    {
      CAT_MUSIC,
      CAT_FESTIVAL,
      CAT_STANDUP,
      CAT_NEWYEAR,
      CAT_THEATRE,
      CAT_SPORT,
      CAT_GENERIC,
    },
    {
      CAT_MUSIC: "koncert",
      CAT_FESTIVAL: "festival",
      CAT_STANDUP: "stand-up",
      CAT_NEWYEAR: "docek",
      CAT_THEATRE: "pozoriste",
      CAT_SPORT: "sport",
      CAT_GENERIC: "dogadjaj",
    },
  );
});

test("a token is never BOTH a decisive-accept and a decisive-reject", () => {
  // step 3 accepts PRIMARY on any MUSIC_STRONG token; step 2 rejects on any
  // HARD_NEGATIVE token. An overlap would make the outcome depend on which
  // branch a given category happens to take.
  assert.deepEqual(intersection(MUSIC_STRONG, HARD_NEGATIVE), []);
  // step 2 checks HARD_NEGATIVE strictly before NIGHTLIFE_SECONDARY, so an
  // overlap there is dead weight at best and contradictory at worst.
  assert.deepEqual(intersection(NIGHTLIFE_SECONDARY, HARD_NEGATIVE), []);
});

test("MUSIC_STRONG and NON_MUSIC_FESTIVAL are opposing signals — never the same token", () => {
  // the `festival` branch treats a MUSIC_STRONG hit and a NON_MUSIC_FESTIVAL hit
  // as pulling in opposite directions; a shared token would be ambiguous.
  assert.deepEqual(intersection(MUSIC_STRONG, NON_MUSIC_FESTIVAL), []);
});

test("KIDS is the authoritative kids list; HARD_NEGATIVE only repeats its adjective forms", () => {
  // `relevance.ts` folds KIDS into the step-2 gate via `HARD_NEGATIVE ?? kids`,
  // and every kids token that HARD_NEGATIVE carries directly must also be in
  // KIDS so the two paths agree. The noun forms ("dete"/"deca") are deliberately
  // KIDS-only.
  assert.deepEqual(intersection(HARD_NEGATIVE, KIDS), ["decija", "deciji", "decje", "decji"]);
  for (const t of intersection(HARD_NEGATIVE, KIDS)) {
    assert.ok(KIDS.has(t));
  }
  assert.ok(KIDS.has("dete") && !HARD_NEGATIVE.has("dete"));
  assert.ok(KIDS.has("deca") && !HARD_NEGATIVE.has("deca"));
});

test("every set is non-empty and holds only lower-case de-accented tokens", () => {
  for (const [name, set] of Object.entries({
    HARD_NEGATIVE,
    MUSIC_STRONG,
    NIGHTLIFE_SECONDARY,
    NON_MUSIC_FESTIVAL,
    KIDS,
    FESTIVAL_TOKENS,
    NIGHT_TOKENS,
  })) {
    assert.ok(set.size > 0, `${name} must not be empty`);
    for (const token of set) {
      assert.equal(token, token.toLowerCase(), `${name}: "${token}" must be lower-case`);
      assert.match(token, /^[a-z0-9]+$/, `${name}: "${token}" must be a single de-accented token`);
    }
  }
});

test("MUSIC_STRONG and NIGHTLIFE_SECONDARY never share a token (a shared one would be dead in the secondary list)", () => {
  // every branch checks MUSIC_STRONG first, so a shared token could never
  // produce a secondary result.
  assert.deepEqual(intersection(MUSIC_STRONG, NIGHTLIFE_SECONDARY), []);
});

test("FESTIVAL_TOKENS / NIGHT_TOKENS are subsets of NIGHTLIFE_SECONDARY; it is disjoint from NON_MUSIC_FESTIVAL", () => {
  // relevance.ts vetoes free-text festival-only evidence with NON_MUSIC_FESTIVAL
  // by removing FESTIVAL_TOKENS from NIGHTLIFE_SECONDARY: an entry outside the
  // secondary list would be a no-op, and a secondary token that is ALSO a
  // non-music marker would veto itself.
  for (const t of FESTIVAL_TOKENS) assert.ok(NIGHTLIFE_SECONDARY.has(t), t);
  // same for NIGHT_TOKENS, which the `docek` branch removes from its evidence
  for (const t of NIGHT_TOKENS) assert.ok(NIGHTLIFE_SECONDARY.has(t), t);
  assert.deepEqual(intersection(NIGHTLIFE_SECONDARY, NON_MUSIC_FESTIVAL), []);
});
