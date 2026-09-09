import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRelevance } from "../../src/events/relevance.ts";

test("relevance: 'koncert' category is always PRIMARY", () => {
  const r = classifyRelevance({
    title: "Kamelot",
    description: "Power metal velikani se vraćaju u Beograd.",
    categories: ["koncert"],
    eventType: "Koncert",
  });
  assert.deepEqual(r, { accepted: true, tier: "primary", reason: 'category "koncert"' });
});

test("relevance: electronic club night with DJ lineup keywords -> PRIMARY", () => {
  const r = classifyRelevance({
    title: "Intercell with DVS1",
    description: "Two rooms running on weight and repetition. DVS1 [3 hour set], Temudo, mdngt.",
    categories: ["drugstore-karmakoma-beograd", "koncert"],
  });
  assert.equal(r.accepted, true);
  if (r.accepted) assert.equal(r.tier, "primary");
});

test("relevance: DJ / b2b keywords carry a venue-group-only event to PRIMARY", () => {
  const r = classifyRelevance({
    title: "Alterego – Daria Kolosova, Insolate",
    description: "Techno all night, b2b set to close.",
    categories: ["drugstore-karmakoma-beograd"],
  });
  assert.equal(r.accepted, true);
  if (r.accepted) assert.equal(r.tier, "primary");
});

test("relevance: stand-up is SECONDARY, not rejected for 'predstava' in the blurb", () => {
  const r = classifyRelevance({
    title: 'StandUpFest – PREMIJERA: "Katran i perje"',
    description: "Novi specijal — nova predstava, nove šale, isti Srđan.",
    categories: ["stand-up"],
    eventType: "Stand up",
  });
  assert.equal(r.accepted, true);
  if (r.accepted) assert.equal(r.tier, "secondary");
});

test("relevance: rejects a supercar show (hard-negative keyword)", () => {
  const r = classifyRelevance({
    title: "GT SERBIA - međunarodni supercar show",
    description: "Najveći auto događaj u regionu, na Beogradskom sajmu.",
    categories: ["dogadjaj"],
    eventType: "Događaj",
  });
  assert.equal(r.accepted, false);
  if (!r.accepted) assert.match(r.reason, /supercar/);
});

test("relevance: rejects theatre / lectures / exhibitions / sport", () => {
  for (const [title, cats] of [
    ["Bračni prevrtljivci", ["pozoriste"]],
    ["Predavanje o astrofizici", ["dogadjaj"]],
    ["Izložba savremene skulpture", ["dogadjaj"]],
    ["Košarka: Partizan – Zvezda", ["sport"]],
  ] as const) {
    const r = classifyRelevance({ title, categories: [...cats] });
    assert.equal(r.accepted, false, `${title} should be rejected`);
  }
});

test("relevance: 'dogadjaj' with no signal is rejected with a clear reason", () => {
  const r = classifyRelevance({
    title: "Sajam vina i sira",
    categories: ["dogadjaj"],
  });
  assert.equal(r.accepted, false);
  if (!r.accepted) assert.match(r.reason, /sajam|dogadjaj/);
});

test("relevance: music festival PRIMARY, wine festival rejected", () => {
  const music = classifyRelevance({
    title: "Naxatras Live",
    description: "Grčki psychedelic bend, koncert u SKCNS Fabrika.",
    categories: ["festival"],
  });
  assert.equal(music.accepted, true);
  if (music.accepted) assert.equal(music.tier, "primary");

  const wine = classifyRelevance({
    title: "Wine Fest 2026",
    description: "Degustacija vina iz cele Srbije.",
    categories: ["festival"],
  });
  assert.equal(wine.accepted, false);
});

test("relevance: every rejection carries a non-empty reason", () => {
  const r = classifyRelevance({ title: "Nešto", categories: [] });
  assert.equal(r.accepted, false);
  if (!r.accepted) assert.ok(r.reason.length > 0);
});

// ---- REGRESSIONS -------------------------------------------------------

test("[regression] a kids festival is rejected even though 'festival' is a decisive category", () => {
  const r = classifyRelevance({
    title: "Dečji festival",
    description: "Program za decu ceo dan.",
    categories: ["festival"],
  });
  assert.equal(r.accepted, false, "KIDS must reject even an otherwise-accepted festival-secondary");
  if (!r.accepted) assert.match(r.reason, /kids/);
});

test("[regression] a music festival stays PRIMARY even with a kids marker in the blurb (music wins)", () => {
  const r = classifyRelevance({
    title: "Rok festival",
    description: "Koncert za sve, i deca su dobrodošla.",
    categories: ["festival"],
  });
  assert.equal(r.accepted, true);
  if (r.accepted) assert.equal(r.tier, "primary");
});

test("[regression] a kids New Year event is rejected (docek accepts only at secondary; kids outranks)", () => {
  const r = classifyRelevance({
    title: "Dečji doček Nove godine",
    description: "Doček u podne, animacija za decu.",
    categories: ["docek"],
  });
  assert.equal(r.accepted, false);
  if (!r.accepted) assert.match(r.reason, /kids/);
});

// ---- contract lock-ins ----------------------------------------------

test("relevance: venueCategory is never consulted — identical result for every venue category", () => {
  const results = ([null, "nightclub", "concert_hall", "theatre", "restaurant"] as const).map(
    (venueCategory) =>
      classifyRelevance({
        title: "Panel o urbanizmu",
        description: "Diskusija gradskih arhitekata.",
        categories: ["dogadjaj"],
        venueCategory,
      }),
  );
  for (const r of results) assert.deepEqual(r, results[0]);
  assert.equal(results[0].accepted, false);
});

test("relevance: result and reason are independent of category and lineup order", () => {
  const a = classifyRelevance({
    title: "Veče uz muziku",
    categories: ["festival", "dogadjaj"],
    lineup: [{ name: "The Band" }, { name: "DJ Krush" }],
  });
  const b = classifyRelevance({
    title: "Veče uz muziku",
    categories: ["dogadjaj", "festival"],
    lineup: [{ name: "DJ Krush" }, { name: "The Band" }],
  });
  assert.deepEqual(a, b);
});
