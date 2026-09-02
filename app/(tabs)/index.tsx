import { useCallback, useEffect, useRef, useState } from "react";

import * as Location from "expo-location";

import {
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import CitySelector from "@/components/CitySelector";
import CountrySelector from "@/components/CountrySelector";
import MusicSelector from "@/components/MusicSelector";

import { countries } from "@/constants/locations";
import { musicGenres } from "@/constants/nightlifeData";
import { fetchVenues, type Venue } from "@/lib/venues";

export default function HomeScreen() {
  const [selectedCountry, setSelectedCountry] = useState("");
  const [selectedCity, setSelectedCity] = useState("");
  const [selectedMusic, setSelectedMusic] = useState<string[]>([]);

  const [countryError, setCountryError] = useState("");
  const [cityError, setCityError] = useState("");
  const [musicError, setMusicError] = useState("");

  const [allVenues, setAllVenues] = useState<Venue[]>([]);
  const [venuesLoading, setVenuesLoading] = useState(true);
  const [venuesError, setVenuesError] = useState("");

  const [results, setResults] = useState<Venue[]>([]);
  const [showResults, setShowResults] = useState(false);

  const [openSelector, setOpenSelector] = useState<
    "country" | "city" | "music" | null
  >(null);

  const [coords, setCoords] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [locationStatus, setLocationStatus] = useState<
    "loading" | "granted" | "denied" | "error"
  >("loading");

  useEffect(() => {
    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();

      if (cancelled) return;

      if (status !== "granted") {
        setLocationStatus("denied");
        return;
      }

      try {
        subscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: 5000,
            distanceInterval: 10,
          },
          (position) => {
            if (cancelled) return;

            setCoords({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
            });
            setLocationStatus("granted");
          },
        );
      } catch {
        if (!cancelled) setLocationStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetchVenues()
      .then((data) => {
        if (cancelled) return;
        setAllVenues(data);
        setVenuesError("");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setVenuesError(
          error instanceof Error ? error.message : "Failed to load venues.",
        );
      })
      .finally(() => {
        if (!cancelled) setVenuesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function closeSelector() {
    setOpenSelector(null);
    Keyboard.dismiss();
  }

  // Refs (not state) so the back-button handler always reads the latest
  // values without needing to re-subscribe the listener on every change.
  const keyboardVisibleRef = useRef(false);
  const openSelectorRef = useRef(openSelector);

  useEffect(() => {
    openSelectorRef.current = openSelector;
  }, [openSelector]);

  useEffect(() => {
    const showSubscription = Keyboard.addListener("keyboardDidShow", () => {
      keyboardVisibleRef.current = true;
    });
    const hideSubscription = Keyboard.addListener("keyboardDidHide", () => {
      keyboardVisibleRef.current = false;
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  // Android back button priority: dismiss the keyboard first if it's open,
  // otherwise close an open dropdown, otherwise let normal back navigation
  // happen. Also used as each selector Modal's onRequestClose so the same
  // priority applies regardless of which one Android routes the press to.
  const handleBackButton = useCallback(() => {
    if (keyboardVisibleRef.current) {
      Keyboard.dismiss();
      return true;
    }

    if (openSelectorRef.current !== null) {
      setOpenSelector(null);
      return true;
    }

    return false;
  }, []);

  useEffect(() => {
    if (Platform.OS !== "android") return;

    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      handleBackButton,
    );

    return () => {
      subscription.remove();
    };
  }, [handleBackButton]);

  const citiesForSelectedCountry =
    countries.find((country) => country.id === selectedCountry)?.cities ??
    [];

  function toggleMusic(genre: string) {
    if (selectedMusic.includes(genre)) {
      setSelectedMusic(selectedMusic.filter((music) => music !== genre));
    } else {
      setSelectedMusic([...selectedMusic, genre]);
    }

    setMusicError("");
    setShowResults(false);
  }

  function handleCountrySelect(countryId: string) {
    setSelectedCountry(countryId);
    setSelectedCity("");
    setCountryError("");
    setShowResults(false);
  }

  function handleCitySelect(city: string) {
    setSelectedCity(city);
    setCityError("");
    setShowResults(false);
  }

  function handleSearch() {
    let hasError = false;

    if (selectedCountry === "") {
      setCountryError("Select a country.");
      hasError = true;
    }

    if (selectedCity === "") {
      setCityError("Select a city.");
      hasError = true;
    }

    if (selectedMusic.length === 0) {
      setMusicError("Select at least one music genre.");
      hasError = true;
    }

    if (hasError) {
      setShowResults(false);
      return;
    }

    const filteredVenues = allVenues.filter((venue) => {
      const matchesCountry = venue.country === selectedCountry;
      const matchesCity = venue.city === selectedCity;

      const matchesMusic = selectedMusic.some((music) =>
        venue.musicGenres.includes(music),
      );

      return matchesCountry && matchesCity && matchesMusic;
    });

    setResults(filteredVenues);
    setShowResults(true);
  }

  return (
    <ScrollView
      style={styles.scrollView}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Where are we going tonight?</Text>

      <Text style={styles.subtitle}>Find the best places to go out.</Text>

      <View style={styles.locationBox}>
        {locationStatus === "loading" && (
          <Text style={styles.statusText}>Getting your location…</Text>
        )}

        {locationStatus === "granted" && coords && (
          <Text style={styles.statusText}>
            📍 Lat: {coords.latitude.toFixed(5)}, Lng:{" "}
            {coords.longitude.toFixed(5)}
          </Text>
        )}

        {locationStatus === "denied" && (
          <Text style={styles.errorText}>
            Location permission denied. Enable it in your device settings to
            use location features.
          </Text>
        )}

        {locationStatus === "error" && (
          <Text style={styles.errorText}>
            Couldn&apos;t get your location. Please try again.
          </Text>
        )}
      </View>

      <Text style={styles.sectionTitle}>Select a country</Text>

      <CountrySelector
        countries={countries}
        selectedCountry={selectedCountry}
        onSelectCountry={handleCountrySelect}
        isOpen={openSelector === "country"}
        onOpen={() => setOpenSelector("country")}
        onClose={closeSelector}
        onBackButtonPress={handleBackButton}
      />

      {countryError !== "" && (
        <Text style={styles.errorText}>{countryError}</Text>
      )}

      <Text style={styles.sectionTitle}>Select a city</Text>

      <CitySelector
        key={selectedCountry}
        cities={citiesForSelectedCountry}
        selectedCity={selectedCity}
        onSelectCity={handleCitySelect}
        disabled={selectedCountry === ""}
        isOpen={openSelector === "city"}
        onOpen={() => setOpenSelector("city")}
        onClose={closeSelector}
        onBackButtonPress={handleBackButton}
      />

      {cityError !== "" && <Text style={styles.errorText}>{cityError}</Text>}

      <Text style={styles.sectionTitle}>What music do you like?</Text>

      <MusicSelector
        genres={musicGenres}
        selectedMusic={selectedMusic}
        onToggleMusic={toggleMusic}
        isOpen={openSelector === "music"}
        onOpen={() => setOpenSelector("music")}
        onClose={closeSelector}
        onBackButtonPress={handleBackButton}
      />

      {musicError !== "" && <Text style={styles.errorText}>{musicError}</Text>}

      <Pressable style={styles.searchButton} onPress={handleSearch}>
        <Text style={styles.searchButtonText}>FIND PLACES</Text>
      </Pressable>

      {venuesLoading && (
        <Text style={styles.statusText}>Loading venues…</Text>
      )}

      {venuesError !== "" && (
        <Text style={styles.errorText}>{venuesError}</Text>
      )}

      {showResults && (
        <View style={styles.resultsBox}>
          <Text style={styles.resultsTitle}>Search results</Text>

          {results.length > 0 ? (
            results.map((venue) => (
              <View key={venue.id} style={styles.venueCard}>
                <Text style={styles.venueName}>{venue.name}</Text>

                <Text style={styles.venueText}>
                  🎵 {venue.musicGenres.join(", ")}
                </Text>

                <Text style={styles.venueText}>
                  🕐 Open until {venue.closingTime}
                </Text>

                {venue.distance !== undefined && (
                  <Text style={styles.venueText}>📍 {venue.distance} km</Text>
                )}
              </View>
            ))
          ) : (
            <Text style={styles.resultsText}>
              No places match your search.
            </Text>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },

  container: {
    padding: 30,
    alignItems: "center",
    paddingBottom: 50,
  },

  title: {
    fontSize: 32,
    fontWeight: "bold",
    marginTop: 30,
    marginBottom: 8,
  },

  subtitle: {
    fontSize: 16,
    marginBottom: 30,
  },

  locationBox: {
    width: "100%",
    maxWidth: 500,
    marginBottom: 10,
  },

  sectionTitle: {
    width: "100%",
    maxWidth: 500,
    fontSize: 20,
    fontWeight: "bold",
    marginTop: 20,
    marginBottom: 12,
  },

  errorText: {
    width: "100%",
    maxWidth: 500,
    marginTop: 6,
    color: "red",
    fontSize: 14,
  },

  statusText: {
    width: "100%",
    maxWidth: 500,
    marginTop: 6,
    fontSize: 14,
  },

  searchButton: {
    width: "100%",
    maxWidth: 500,
    marginTop: 30,
    paddingVertical: 15,
    borderRadius: 10,
    backgroundColor: "#007AFF",
    alignItems: "center",
  },

  searchButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "bold",
  },

  resultsBox: {
    width: "100%",
    maxWidth: 500,
    marginTop: 25,
    padding: 20,
    borderRadius: 12,
    backgroundColor: "#eee",
  },

  resultsTitle: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 10,
  },

  resultsText: {
    fontSize: 16,
    marginVertical: 4,
  },

  venueCard: {
    width: "100%",
    padding: 15,
    marginTop: 10,
    borderRadius: 10,
    backgroundColor: "#fff",
  },

  venueName: {
    fontSize: 18,
    fontWeight: "bold",
    marginBottom: 8,
  },

  venueText: {
    fontSize: 14,
    marginVertical: 2,
  },
});
