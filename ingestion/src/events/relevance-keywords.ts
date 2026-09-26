/**
 * Curated keyword / category data for the relevance classifier
 * (`./relevance.ts`).
 *
 * This module is PURE DATA — no logic. It is separated from the classifier so
 * the decision tree in `relevance.ts` can be read on its own, and so the word
 * lists can be reviewed and extended without touching the branching.
 *
 * The lists mix Serbian (de-accented, as `tokenize` produces) and English
 * tokens. Editing them is a deliberate curation step, not a code change.
 *
 * How an entry actually matches (`./text.ts#tokenize` + exact `Set.has`):
 *   - WHOLE TOKENS only, never substrings: "koncert" does not match
 *     "koncerta" — Serbian case forms must be listed explicitly.
 *   - Hyphens and spaces split: "open-air" / "open air" are the two tokens
 *     "open" + "air"; "openair" is one. A phrase can only be matched through
 *     one of its words, which is why some short, generic-looking words
 *     ("open", "stand") are here — removing them drops the phrase.
 *   - De-accenting creates homographs: "štand" (a stall) becomes "stand".
 *   - Non-Latin script produces no tokens at all (Cyrillic text never matches).
 */

/**
 * GIGS TIX `eventcat-*` category slugs whose meaning the classifier relies on.
 * Venue-group categories (e.g. `drugstore-karmakoma-beograd`) are ignored.
 */
export const CAT_MUSIC = "koncert";
export const CAT_FESTIVAL = "festival";
export const CAT_STANDUP = "stand-up";
export const CAT_NEWYEAR = "docek";
export const CAT_THEATRE = "pozoriste";
export const CAT_SPORT = "sport";
export const CAT_GENERIC = "dogadjaj";

/**
 * Hard-negative tokens. If any appears in the title, description or event-type
 * text, the event is rejected outright — these name activities this app does
 * not cover. (Matched as whole tokens after de-accenting, so "sajam" will not
 * fire on a venue name embedded elsewhere — venue text is not scanned here.)
 */
export const HARD_NEGATIVE = new Set<string>([
  // fairs / expos / trade
  "sajam",
  "sajamski",
  "expo",
  "bazar",
  "vasar",
  // talks / learning
  "konferencija",
  "kongres",
  "samit",
  "seminar",
  "predavanje",
  "radionica",
  "webinar",
  "trening",
  "obuka",
  // visual / screen / static culture
  "izlozba",
  "izlozbe",
  "postavka",
  "projekcija",
  "bioskop",
  // stage forms that are not nightlife
  "predstava",
  "predstave",
  "opera",
  "balet",
  "mjuzikl",
  "monodrama",
  "matine",
  // sport / competition
  "utakmica",
  "mec",
  "turnir",
  "trka",
  "maraton",
  "sampionat",
  "prvenstvo",
  "kviz",
  // kids / other
  "deciji",
  "decija",
  "decji",
  "decje",
  // motoring
  "supercar",
  "oldtajmer",
  "reli",
]);

/**
 * Strong positive music / nightlife tokens. Any one grants PRIMARY (unless a
 * hard-negative already fired).
 */
export const MUSIC_STRONG = new Set<string>([
  "koncert",
  "koncerti",
  // Case forms of the core music nouns (matching is whole-token): "početak
  // koncerta", "povratak benda", "promocija albuma". Nouns only — adjectives
  // like "koncertna" name venues ("Koncertna dvorana"), which are never a
  // relevance signal.
  "koncerta",
  "koncertu",
  "koncertom",
  "koncertima",
  "concert",
  "nastup",
  "nastupa",
  "nastupom",
  "svirka",
  "svirke",
  "svirku",
  "live",
  "uzivo",
  "tribute",
  "tributes",
  "orkestar",
  "orkestra",
  "orkestrom",
  "orchestra",
  "bend",
  "benda",
  "bendom",
  "bendovi",
  "bendova",
  "band",
  "dj",
  "djs",
  "b2b",
  "rave",
  "techno",
  "tehno",
  "house",
  "trance",
  "elektronska",
  "electronic",
  "clubbing",
  "soundsystem",
  "sound",
  "warmup",
  "afterparty",
  "album",
  "albuma",
  "singl",
  "spot",
  "turneja",
  "turneje",
  "turneju",
  "tour",
  "unplugged",
  "acoustic",
  "akusticni",
  "akusticno",
  "akusticna",
  "jam",
  // Generic "music" and unambiguous genre names. Without them a titled
  // "Wine & Jazz Festival" / "Street Music Festival" had no music evidence and
  // lost to the non-music festival veto. Deliberately NOT: "rok" (deadline),
  // "metal" (the material), "pop"/"soul" (pop-up, soul food).
  "music",
  "muzika",
  "muzike",
  "muziku",
  "muzikom",
  "muzicki",
  "jazz",
  "dzez",
  "blues",
  "bluz",
  "rock",
  "punk",
  "reggae",
  "hiphop",
  // "hop": the usual "hip hop" / "hip-hop" spelling splits into two tokens and
  // "hiphop" alone would miss it ("hip" is the ambiguous half). Known cost:
  // the "hop on hop off" tourist bus also matches (as "tour" already does).
  "hop",
  "rap",
  "disco",
  "funk",
]);

/**
 * Secondary nightlife tokens — accepted at SECONDARY tier (kept, but flagged)
 * when there is no hard-negative and no strong signal.
 */
export const NIGHTLIFE_SECONDARY = new Set<string>([
  "zurka",
  "zurke",
  "party",
  "partijem",
  "fest",
  "festival",
  "openair",
  "open",
  // NOT "air" alone: tokenize splits "open air"/"open-air" into the two
  // tokens "open" and "air", but "open" already matches that phrasing on its
  // own — so a standalone "air" entry never adds a genuine "open air" match
  // that "open" (or the compound "openair") wouldn't already catch, while it
  // DOES independently false-positive on unrelated uses of the word "air"
  // ("Air Serbia", "hot air balloon", "on air", "air conditioning", ...).
  "standup",
  // "stand": the only way to catch "stand-up" / "stand up" (split into two
  // tokens). Known cost: de-accented "štand" (a stall) also matches.
  "stand",
  "komedija",
  "kabare",
  "cabaret",
  "improvizacija",
  "docek",
  "nocna",
  "noc",
  "night",
]);

/**
 * The `NIGHTLIFE_SECONDARY` entries that say only "festival". On the free-text
 * path they are as weak as a `festival` category, so `NON_MUSIC_FESTIVAL`
 * vetoes them the same way (see `relevance.ts`).
 */
export const FESTIVAL_TOKENS = new Set<string>(["fest", "festival"]);

/**
 * The `NIGHTLIFE_SECONDARY` entries that only say "night". A New Year event is
 * a night event by definition ("novogodišnja noć"), so for the `docek`
 * category these are not party evidence (see `relevance.ts`).
 */
export const NIGHT_TOKENS = new Set<string>(["nocna", "noc", "night"]);

/**
 * Non-music festival markers — a festival that is really something else.
 * Applied to the `festival` category AND to free-text festival evidence.
 */
export const NON_MUSIC_FESTIVAL = new Set<string>([
  "vina",
  "vinski",
  "vino",
  "wine",
  "piva",
  "beer",
  "hrane",
  "food",
  "gastro",
  "street",
  "knjiga",
  "knjige",
  "knjizevni",
  "book",
  "film",
  "filmski",
  // genitive forms — the usual Serbian naming: "Festival filma", "Festival
  // nauke", "Festival knjige", "Festival pozorišta"
  "filma",
  "filmova",
  "pozorisni",
  "pozorista",
  "teatarski",
  "naucni",
  "nauke",
  "science",
  "cveca",
  "turisticki",
]);

/**
 * Kids-programming markers — reject even for an otherwise-accepted decisive
 * category (`festival` / `stand-up` / `docek`). This is the authoritative kids
 * list; `HARD_NEGATIVE` additionally repeats the adjective forms so a
 * non-decisive-category kids event is caught by the plain hard-negative gate
 * too (see `relevance.ts`).
 */
export const KIDS = new Set<string>(["deciji", "decija", "decji", "decje", "dete", "deca"]);
