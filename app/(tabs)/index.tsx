import { useState } from "react";

import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import CitySelector from "@/components/CitySelector";
import CountrySelector from "@/components/CountrySelector";
import MusicSelector from "@/components/MusicSelector";

import { countries } from "@/constants/locations";
import { musicGenres } from "@/constants/nightlifeData";
import { venues } from "@/constants/venues";

export default function HomeScreen() {
  const [selectedCountry, setSelectedCountry] = useState("");
  const [selectedCity, setSelectedCity] = useState("");
  const [selectedMusic, setSelectedMusic] = useState<string[]>([]);

  const [countryError, setCountryError] = useState("");
  const [cityError, setCityError] = useState("");
  const [musicError, setMusicError] = useState("");

  const [results, setResults] = useState<typeof venues>([]);
  const [showResults, setShowResults] = useState(false);

  const [openSelector, setOpenSelector] = useState<
    "country" | "city" | "music" | null
  >(null);

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

    const filteredVenues = venues.filter((venue) => {
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
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Where are we going tonight?</Text>

      <Text style={styles.subtitle}>Find the best places to go out.</Text>

      <Text style={styles.sectionTitle}>Select a country</Text>

      <CountrySelector
        countries={countries}
        selectedCountry={selectedCountry}
        onSelectCountry={handleCountrySelect}
        isOpen={openSelector === "country"}
        onOpen={() => setOpenSelector("country")}
        onClose={() => setOpenSelector(null)}
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
        onClose={() => setOpenSelector(null)}
      />

      {cityError !== "" && <Text style={styles.errorText}>{cityError}</Text>}

      <Text style={styles.sectionTitle}>What music do you like?</Text>

      <MusicSelector
        genres={musicGenres}
        selectedMusic={selectedMusic}
        onToggleMusic={toggleMusic}
        isOpen={openSelector === "music"}
        onOpen={() => setOpenSelector("music")}
        onClose={() => setOpenSelector(null)}
      />

      {musicError !== "" && <Text style={styles.errorText}>{musicError}</Text>}

      <Pressable style={styles.searchButton} onPress={handleSearch}>
        <Text style={styles.searchButtonText}>FIND PLACES</Text>
      </Pressable>

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

                <Text style={styles.venueText}>📍 {venue.distance} km</Text>
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
