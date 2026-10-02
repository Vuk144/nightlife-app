import type { SupabaseClient } from "@supabase/supabase-js";

// The venue discovery query and its row → UI mapping, independent of the app's
// configured client (`./supabase`, which needs the Expo env at import time) so
// it can be exercised against a fake client in tests.

// Raw shape returned by the query below (before mapping to the UI shape).
type VenueQueryRow = {
  id: string;
  name: string;
  closing_time: string | null;
  is_active: boolean;
  latitude: number | null;
  longitude: number | null;
  cities: { name: string; country_id: string } | null;
  music_genres: { name: string }[];
};

// Shape the UI consumes. Mirrors constants/venues.ts `Venue`, except `id` is a
// UUID string and `distance` is optional — the database has no distance data
// (it is derived from the user's location at query time, not stored).
export type Venue = {
  id: string;
  name: string;
  country: string;
  city: string;
  musicGenres: string[];
  closingTime: string;
  latitude: number | null;
  longitude: number | null;
  distance?: number;
};

/**
 * Active venues only: `is_active = false` (deactivated by a curator, or by the
 * ingestion lifecycle once a venue is gone from its source) is filtered out in
 * the query itself, so inactive rows never reach the app.
 */
export async function queryActiveVenues(client: Pick<SupabaseClient, "from">): Promise<Venue[]> {
  const { data, error } = await client
    .from("venues")
    .select(
      "id, name, closing_time, is_active, latitude, longitude, cities(name, country_id), music_genres(name)",
    )
    .eq("is_active", true)
    .order("name")
    .returns<VenueQueryRow[]>();

  if (error) {
    throw new Error(`Failed to fetch venues: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    country: row.cities?.country_id ?? "",
    city: row.cities?.name ?? "",
    musicGenres: row.music_genres.map((genre) => genre.name),
    closingTime: (row.closing_time ?? "").slice(0, 5), // "04:00:00" -> "04:00"
    latitude: row.latitude,
    longitude: row.longitude,
  }));
}
