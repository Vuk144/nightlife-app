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

test("[regression] a New Year event whose only signal is the word 'docek' itself is rejected, not trivially accepted", () => {
  // Every docek-categorized event's own title says "Doček" — that word alone
  // must not count as its own "party signal" evidence, or this rejection path
  // would be unreachable for the common case.
  const r = classifyRelevance({
    title: "Doček Nove Godine u Sala X",
    description: "Doček u restoranu, rezervacije na broj telefona.",
    categories: ["docek"],
  });
  assert.equal(r.accepted, false);
  if (!r.accepted) assert.match(r.reason, /New Year event with no music.party signal/);
});

test("[regression] a New Year event with genuine additional signal is still accepted (secondary)", () => {
  const withParty = classifyRelevance({
    title: "Doček Nove Godine",
    description: "Žurka uz najbolje hitove, DJ do zore.",
    categories: ["docek"],
  });
  assert.equal(withParty.accepted, true);
  if (withParty.accepted) assert.equal(withParty.tier, "secondary");

  const withMusic = classifyRelevance({
    title: "Doček Nove Godine",
    description: "Live bend nastupa u ponoć.",
    categories: ["docek"],
  });
  assert.equal(withMusic.accepted, true);
  if (withMusic.accepted) assert.equal(withMusic.tier, "secondary");
});

test("[regression] 'open air' (two words, no other signal) is still accepted via 'open', not 'air'", () => {
  const r = classifyRelevance({
    title: "Open Air @ Barutana",
    categories: ["dogadjaj"],
  });
  assert.equal(r.accepted, true);
  if (r.accepted) {
    assert.equal(r.tier, "secondary");
    assert.match(r.reason, /"open"/);
  }
});

test("[regression] an unrelated mention of 'air' alone does not grant nightlife relevance", () => {
  // Confirms "air" was correctly dropped from NIGHTLIFE_SECONDARY: it never
  // added real recall over "open"/"openair" (see relevance-keywords.ts), only
  // false-positive risk on unrelated uses of the word.
  const r = classifyRelevance({
    title: "Air Serbia najavljuje novu liniju",
    description: "Detalji o letovima i cenama karata.",
    categories: ["dogadjaj"],
  });
  assert.equal(r.accepted, false);
});

test("[regression] free-text 'festival' + a non-music marker is rejected like the festival CATEGORY is", () => {
  // Before: "Festival vina" was rejected as `festival` but accepted (secondary)
  // as `dogadjaj` via the free-text word "festival".
  for (const [title, marker] of [
    ["Festival vina 2026", "vina"],
    ["Beer Fest Beograd", "beer"],
    ["Street Food Festival", "food"],
    ["Filmski festival", "filmski"],
  ] as const) {
    const asCategory = classifyRelevance({ title, categories: ["festival"] });
    const asText = classifyRelevance({ title, categories: ["dogadjaj"] });
    assert.equal(asCategory.accepted, false, `${title} (category)`);
    assert.equal(asText.accepted, false, `${title} (free text)`);
    if (!asText.accepted) assert.match(asText.reason, new RegExp(`non-music marker "${marker}"`));
  }

  // music evidence still wins, and other nightlife evidence is not vetoed
  const withConcerts = classifyRelevance({ title: "Beer Fest", description: "Koncerti svake večeri.", categories: ["dogadjaj"] });
  assert.equal(withConcerts.accepted && withConcerts.tier, "primary");
  const withParty = classifyRelevance({ title: "Festival vina i žurka", categories: ["dogadjaj"] });
  assert.equal(withParty.accepted && withParty.tier, "secondary");
  // a festival with no non-music marker is unchanged
  const plain = classifyRelevance({ title: "Exit festival", categories: ["dogadjaj"] });
  assert.equal(plain.accepted && plain.tier, "secondary");
});

test("[regression] Serbian case forms of the core music nouns are music evidence (whole-token matching)", () => {
  for (const description of [
    "Početak koncerta u 21h.",
    "Veliki povratak benda na scenu.",
    "Promocija novog albuma.",
    "Uz gostovanje orkestra.",
    "Deo regionalne turneje.",
  ]) {
    const r = classifyRelevance({ title: "Veče u klubu", description, categories: ["dogadjaj"] });
    assert.equal(r.accepted && r.tier, "primary", description);
  }
  // a concert-hall VENUE name is not an event signal (adjective deliberately not listed)
  assert.equal(
    classifyRelevance({ title: "Obilazak zgrade", description: "Koncertna dvorana Kolarac.", categories: ["dogadjaj"] }).accepted,
    false,
  );
});

test("[regression] generic 'music' and genre words are music evidence, so they beat the non-music festival veto on BOTH paths", () => {
  // Before: MUSIC_STRONG had no "music"/genre words, so these were rejected as
  // `festival` — and the free-text veto then rejected them as `dogadjaj` too.
  for (const title of ["Wine & Jazz Festival", "Street Music Festival", "Festival vina i muzike", "Beer & Rock Fest"]) {
    for (const cat of ["festival", "dogadjaj"]) {
      const r = classifyRelevance({ title, categories: [cat] });
      assert.equal(r.accepted && r.tier, "primary", `${title} (${cat}): ${JSON.stringify(r)}`);
    }
  }
  assert.equal(classifyRelevance({ title: "Blues veče", categories: ["dogadjaj"] }).accepted, true);
});

test("[regression] a New Year event's 'night' words are not party evidence (every New Year listing is a night)", () => {
  for (const description of ["Novogodišnja noć u restoranu, rezervacije.", "New Year's Night dinner."]) {
    const r = classifyRelevance({ title: "Doček Nove Godine u Sala X", description, categories: ["docek"] });
    assert.equal(r.accepted, false, description);
  }
  // …but a night PLUS real evidence is still accepted
  const r = classifyRelevance({ title: "Doček Nove Godine", description: "Novogodišnja noć uz DJ-a.", categories: ["docek"] });
  assert.equal(r.accepted && r.tier, "secondary");
});

test("[regression] science / film festivals in their usual genitive naming are non-music festivals", () => {
  for (const title of ["Festival nauke 2026", "Festival kratkog filma", "Festival evropskih filmova"]) {
    for (const cat of ["festival", "dogadjaj"]) {
      assert.equal(classifyRelevance({ title, categories: [cat] }).accepted, false, `${title} (${cat})`);
    }
  }
});

test("[regression] keyword forms as real titles spell them: 'Hip Hop', 'Akustično', theatre / book festivals", () => {
  // tokenize splits "Hip Hop"/"Hip-Hop" — the solid "hiphop" entry alone missed them
  for (const title of ["Hip Hop veče", "Hip-Hop noć"]) {
    assert.equal(classifyRelevance({ title, categories: ["dogadjaj"] }).accepted && "ok", "ok", title);
  }
  const hipHopFest = classifyRelevance({ title: "Beer & Hip Hop Fest", categories: ["dogadjaj"] });
  assert.equal(hipHopFest.accepted && hipHopFest.tier, "primary", "genre evidence beats the non-music veto");
  assert.equal(classifyRelevance({ title: "Akustično veče", categories: ["dogadjaj"] }).accepted, true);
  for (const title of ["BITEF – teatarski festival", "Festival pozorišta", "Festival knjige"]) {
    assert.equal(classifyRelevance({ title, categories: ["festival"] }).accepted, false, title);
  }
});

test("decision order: decisive category > hard-negative/kids gate > strong music > secondary nightlife", () => {
  const at = (title: string, categories: string[], eventType?: string) =>
    classifyRelevance({ title, categories, eventType });
  // 1. decisive categories outrank free text, in koncert > festival > stand-up > docek > theatre/sport order
  assert.equal(at("Izložba", ["pozoriste", "koncert"]).accepted, true, "koncert outranks pozoriste and a hard negative");
  assert.equal(at("Koncert", ["pozoriste"]).accepted, false, "theatre category outranks a music word");
  assert.equal(at("Predstava", ["stand-up", "sport"]).accepted, true, "stand-up outranks sport and a hard negative");
  // 2. the hard-negative gate (fed by title, description, eventType) beats music evidence
  assert.match(String((at("Techno radionica", ["dogadjaj"]) as { reason: string }).reason), /radionica/);
  assert.equal(at("Techno", ["dogadjaj"], "Predstava").accepted, false, "eventType text is scanned");
  assert.equal(at("Dečji DJ party", []).accepted, false, "kids noun/adjective joins the gate");
  // 3. strong music outranks secondary nightlife
  assert.deepEqual(at("DJ žurka", ["dogadjaj"]), { accepted: true, tier: "primary", reason: 'music keyword "dj"' });
  // tokenization: case, accents and punctuation are folded (ŽURKA -> zurka, "stand-up" -> stand + up)
  assert.equal((at("ŽURKA!!!", []) as { tier: string }).tier, "secondary");
  assert.equal((at("Stand-up veče", []) as { tier: string }).tier, "secondary");
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
