import { useState } from "react";

import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import CitySelector from "@/components/CitySelector";
import MusicSelector from "@/components/MusicSelector";

import { cities, musicGenres } from "@/constants/nightlifeData";

export default function HomeScreen() {
  const [selectedCity, setSelectedCity] = useState("");
  const [selectedMusic, setSelectedMusic] = useState<string[]>([]);

  const [cityError, setCityError] = useState("");
  const [musicError, setMusicError] = useState("");
  const [showResults, setShowResults] = useState(false);

  function toggleMusic(genre: string) {
    if (selectedMusic.includes(genre)) {
      setSelectedMusic(selectedMusic.filter((music) => music !== genre));
    } else {
      setSelectedMusic([...selectedMusic, genre]);
    }

    setMusicError("");
    setShowResults(false);
  }

  function handleCitySelect(city: string) {
    setSelectedCity(city);
    setCityError("");
    setShowResults(false);
  }

  function handleSearch() {
    let hasError = false;

    if (selectedCity === "") {
      setCityError("Izaberi grad.");
      hasError = true;
    }

    if (selectedMusic.length === 0) {
      setMusicError("Izaberi bar jednu vrstu muzike.");
      hasError = true;
    }

    if (hasError) {
      setShowResults(false);
      return;
    }

    setShowResults(true);
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Gde idemo večeras?</Text>

      <Text style={styles.subtitle}>Pronađi najbolje mesto za izlazak.</Text>

      <Text style={styles.sectionTitle}>Selektuj grad</Text>

      <CitySelector
        cities={cities}
        selectedCity={selectedCity}
        onSelectCity={handleCitySelect}
      />

      {cityError !== "" && <Text style={styles.errorText}>{cityError}</Text>}

      <Text style={styles.sectionTitle}>Koju muziku voliš?</Text>

      <MusicSelector
        genres={musicGenres}
        selectedMusic={selectedMusic}
        onToggleMusic={toggleMusic}
      />

      {musicError !== "" && <Text style={styles.errorText}>{musicError}</Text>}

      <Pressable style={styles.searchButton} onPress={handleSearch}>
        <Text style={styles.searchButtonText}>PRONAĐI MESTA</Text>
      </Pressable>

      {showResults && (
        <View style={styles.resultsBox}>
          <Text style={styles.resultsTitle}>Rezultati pretrage</Text>

          <Text style={styles.resultsText}>Grad: {selectedCity}</Text>

          <Text style={styles.resultsText}>
            Muzika: {selectedMusic.join(", ")}
          </Text>

          <Text style={styles.resultsText}>
            Ovde će uskoro biti prikazana mesta.
          </Text>
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
});
