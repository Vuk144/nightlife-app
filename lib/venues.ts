import { supabase } from "./supabase";

// Raw shape returned by the query below (before mapping to the UI shape).
type VenueQueryRow = {
  id: string;
  name: string;
  closing_time: string | null;
  is_active: boolean;
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
  distance?: number;
};

export async function fetchVenues(): Promise<Venue[]> {
  const { data, error } = await supabase
    .from("venues")
    .select(
      "id, name, closing_time, is_active, cities(name, country_id), music_genres(name)",
    )
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
  }));
}
