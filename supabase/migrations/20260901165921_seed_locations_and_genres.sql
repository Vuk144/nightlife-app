-- Seed reference data: countries, cities, and music genres.
-- Source of truth: constants/locations.ts and constants/nightlifeData.ts.
--
-- Idempotent: every insert targets a column with a unique constraint
-- (countries.id, cities(country_id, name), music_genres.name) and uses
-- ON CONFLICT ... DO NOTHING, so re-running this migration is a no-op
-- after the first successful run and will never create duplicates.

-- ── countries ────────────────────────────────────────────────────────────
insert into public.countries (id, name) values
  ('RS', 'Serbia'),
  ('ES', 'Spain'),
  ('IT', 'Italy'),
  ('DE', 'Germany'),
  ('AT', 'Austria'),
  ('FR', 'France'),
  ('HU', 'Hungary'),
  ('CZ', 'Czech Republic'),
  ('HR', 'Croatia'),
  ('SI', 'Slovenia'),
  ('BA', 'Bosnia and Herzegovina'),
  ('ME', 'Montenegro'),
  ('MK', 'North Macedonia'),
  ('GR', 'Greece'),
  ('TR', 'Turkey'),
  ('PT', 'Portugal'),
  ('NL', 'Netherlands'),
  ('BE', 'Belgium'),
  ('GB', 'United Kingdom')
on conflict (id) do nothing;

-- ── cities ───────────────────────────────────────────────────────────────
-- country_id is text and matches countries.id directly (both are the ISO
-- alpha-2 code), so no lookup/join is needed to insert cities.
insert into public.cities (country_id, name) values
  ('RS', 'Belgrade'),
  ('RS', 'Novi Sad'),
  ('RS', 'Niš'),
  ('RS', 'Kragujevac'),
  ('RS', 'Subotica'),
  ('RS', 'Pančevo'),
  ('RS', 'Čačak'),
  ('RS', 'Zrenjanin'),
  ('RS', 'Sombor'),
  ('RS', 'Kraljevo'),
  ('RS', 'Užice'),
  ('RS', 'Leskovac'),
  ('RS', 'Novi Pazar'),
  ('RS', 'Šabac'),
  ('RS', 'Valjevo'),

  ('ES', 'Madrid'),
  ('ES', 'Barcelona'),
  ('ES', 'Valencia'),
  ('ES', 'Seville'),
  ('ES', 'Malaga'),

  ('IT', 'Rome'),
  ('IT', 'Milan'),
  ('IT', 'Naples'),
  ('IT', 'Turin'),
  ('IT', 'Venice'),

  ('DE', 'Berlin'),
  ('DE', 'Munich'),
  ('DE', 'Hamburg'),
  ('DE', 'Cologne'),
  ('DE', 'Frankfurt'),

  ('AT', 'Vienna'),
  ('AT', 'Salzburg'),
  ('AT', 'Graz'),
  ('AT', 'Innsbruck'),

  ('FR', 'Paris'),
  ('FR', 'Nice'),
  ('FR', 'Lyon'),
  ('FR', 'Marseille'),

  ('HU', 'Budapest'),
  ('HU', 'Debrecen'),
  ('HU', 'Szeged'),
  ('HU', 'Pécs'),

  ('CZ', 'Prague'),
  ('CZ', 'Brno'),
  ('CZ', 'Ostrava'),
  ('CZ', 'Pilsen'),

  ('HR', 'Zagreb'),
  ('HR', 'Split'),
  ('HR', 'Rijeka'),
  ('HR', 'Dubrovnik'),

  ('SI', 'Ljubljana'),
  ('SI', 'Maribor'),
  ('SI', 'Kranj'),
  ('SI', 'Celje'),

  ('BA', 'Sarajevo'),
  ('BA', 'Banja Luka'),
  ('BA', 'Mostar'),
  ('BA', 'Tuzla'),

  ('ME', 'Podgorica'),
  ('ME', 'Budva'),
  ('ME', 'Kotor'),
  ('ME', 'Nikšić'),

  ('MK', 'Skopje'),
  ('MK', 'Ohrid'),
  ('MK', 'Bitola'),
  ('MK', 'Tetovo'),

  ('GR', 'Athens'),
  ('GR', 'Thessaloniki'),
  ('GR', 'Patras'),
  ('GR', 'Heraklion'),

  ('TR', 'Istanbul'),
  ('TR', 'Ankara'),
  ('TR', 'Izmir'),
  ('TR', 'Antalya'),

  ('PT', 'Lisbon'),
  ('PT', 'Porto'),
  ('PT', 'Coimbra'),
  ('PT', 'Faro'),

  ('NL', 'Amsterdam'),
  ('NL', 'Rotterdam'),
  ('NL', 'The Hague'),
  ('NL', 'Utrecht'),

  ('BE', 'Brussels'),
  ('BE', 'Antwerp'),
  ('BE', 'Ghent'),

  ('GB', 'London'),
  ('GB', 'Manchester'),
  ('GB', 'Liverpool'),
  ('GB', 'Edinburgh')
on conflict (country_id, name) do nothing;

-- ── music_genres ─────────────────────────────────────────────────────────
insert into public.music_genres (name) values
  ('Techno'),
  ('House'),
  ('Deep House'),
  ('Tech House'),
  ('Progressive House'),
  ('Minimal'),
  ('Melodic Techno'),
  ('Hard Techno'),
  ('Trance'),
  ('Psytrance'),
  ('Drum and Bass'),
  ('Dubstep'),
  ('Garage'),
  ('UK Garage'),
  ('Breakbeat'),
  ('Jungle'),
  ('Electro'),
  ('Disco'),
  ('Funk'),
  ('R&B'),
  ('Hip-Hop'),
  ('Rap'),
  ('Trap'),
  ('Pop'),
  ('Rock'),
  ('Indie Rock'),
  ('Alternative Rock'),
  ('Metal'),
  ('Punk'),
  ('Jazz'),
  ('Blues'),
  ('Reggae'),
  ('Dancehall'),
  ('Afrobeats'),
  ('Latin'),
  ('Reggaeton'),
  ('Salsa'),
  ('Balkan'),
  ('Domestic'),
  ('Folk'),
  ('Turbo Folk'),
  ('Ex-Yu Rock'),
  ('Acoustic')
on conflict (name) do nothing;
