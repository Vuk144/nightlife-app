// Isolates all OSRM road-distance logic. Callers pass a user location and a
// list of venues and get back road distances in meters, keyed by venue id —
// no OSRM URL/response details leak out of this file.
//
// Only the OSRM Table service is used, and only for distances:
// https://router.project-osrm.org/table/v1/driving/...
// No duration, geometry, polylines, navigation, or map rendering here.

import type { Venue } from "./venues";

const OSRM_TABLE_URL = "https://router.project-osrm.org/table/v1/driving";

export type Coordinates = {
  latitude: number;
  longitude: number;
};

export type RoadDistanceResult =
  | { ok: true; distancesByVenueId: Record<string, number> }
  | { ok: false; error: string };

// OSRM's own response shape for the Table service (only the fields we use).
type OsrmTableResponse = {
  code: string;
  message?: string;
  distances?: (number | null)[][];
};

function toOsrmCoordinate(coordinates: Coordinates): string {
  // OSRM expects "longitude,latitude" — the reverse of our app's
  // { latitude, longitude } convention.
  return `${coordinates.longitude.toFixed(6)},${coordinates.latitude.toFixed(6)}`;
}

/**
 * Returns road distances (in meters) from `userLocation` to each of
 * `venues`, keyed by venue id. Venues without valid coordinates are skipped
 * entirely — they are never sent to OSRM and never appear in the result.
 *
 * Never throws: any network failure, HTTP error, or invalid/unexpected OSRM
 * response is reported as `{ ok: false, error }` for the caller to handle.
 */
export async function getRoadDistances(
  userLocation: Coordinates,
  venues: Venue[],
): Promise<RoadDistanceResult> {
  const validVenues = venues.filter(
    (venue): venue is Venue & { latitude: number; longitude: number } =>
      venue.latitude !== null && venue.longitude !== null,
  );

  if (validVenues.length === 0) {
    return { ok: true, distancesByVenueId: {} };
  }

  const coordinates = [
    toOsrmCoordinate(userLocation),
    ...validVenues.map((venue) =>
      toOsrmCoordinate({ latitude: venue.latitude, longitude: venue.longitude }),
    ),
  ].join(";");

  const url = `${OSRM_TABLE_URL}/${coordinates}?sources=0&annotations=distance`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    return { ok: false, error: "Failed to reach the routing service." };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `Routing service returned an error (HTTP ${response.status}).`,
    };
  }

  let data: OsrmTableResponse;
  try {
    data = await response.json();
  } catch {
    return { ok: false, error: "Routing service returned an invalid response." };
  }

  if (data.code !== "Ok") {
    return {
      ok: false,
      error: data.message ?? `Routing service returned an error (${data.code}).`,
    };
  }

  // We never restrict `destinations`, so OSRM treats every coordinate we
  // sent — including the source itself at index 0 — as a destination too.
  // distances[0] is therefore [distanceToSelf, ...distanceToEachVenue], one
  // longer than validVenues: index 0 is the user-to-user distance (always
  // 0) and gets ignored; venue i's distance is at index i + 1.
  const distancesFromUser = data.distances?.[0];

  if (
    !Array.isArray(distancesFromUser) ||
    distancesFromUser.length !== validVenues.length + 1
  ) {
    return { ok: false, error: "Routing service returned an unexpected response." };
  }

  const distancesByVenueId: Record<string, number> = {};

  validVenues.forEach((venue, index) => {
    const distance = distancesFromUser[index + 1];

    // OSRM returns null for a destination it couldn't route to — leave that
    // venue out of the result rather than failing the whole request.
    if (distance !== null) {
      distancesByVenueId[venue.id] = distance;
    }
  });

  return { ok: true, distancesByVenueId };
}
