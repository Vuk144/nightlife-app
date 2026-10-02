import { supabase } from "./supabase";
import { queryActiveVenues, type Venue } from "./venue-query";

export type { Venue };

/** Active venues for discovery (`is_active = false` rows are excluded in the query). */
export function fetchVenues(): Promise<Venue[]> {
  return queryActiveVenues(supabase);
}
