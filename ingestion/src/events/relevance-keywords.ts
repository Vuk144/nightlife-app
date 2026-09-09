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
  "concert",
  "nastup",
  "svirka",
  "svirke",
  "live",
  "uzivo",
  "tribute",
  "tributes",
  "orkestar",
  "orchestra",
  "bend",
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
  "singl",
  "spot",
  "turneja",
  "tour",
  "unplugged",
  "acoustic",
  "akusticni",
  "jam",
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
  "air",
  "standup",
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

/** Non-music festival markers — a `festival` that is really something else. */
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
  "knjizevni",
  "book",
  "film",
  "filmski",
  "pozorisni",
  "naucni",
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
