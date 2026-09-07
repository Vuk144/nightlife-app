/**
 * Ingestion targets.
 *
 * Each entry is one (country, city) whose nightlife venues we pull from
 * OpenStreetMap. `osmRelationId` is the OSM administrative-boundary relation
 * used ONLY to scope the Overpass query — it is a source-side query boundary,
 * never stored in the database and never seen by the app.
 *
 * The app's own discovery modes ("near me" via GPS, "explore a city" via
 * country + city) read from the `venues` / `cities` / `countries` tables and
 * are entirely independent of anything in this file.
 *
 * Adding a city later = adding an object here plus a matching row in the
 * `cities` table. No code change.
 */
export interface IngestionTarget {
  /** ISO 3166-1 alpha-2. Must match `countries.id` / `cities.country_id`. */
  countryId: string;
  /** Must match `cities.name` for the resolved city row. */
  cityName: string;
  /** OSM relation id of the city's administrative area (Overpass scope only). */
  osmRelationId: number;
}

export const TARGETS: IngestionTarget[] = [
  { countryId: "RS", cityName: "Belgrade", osmRelationId: 2728438 },
];
