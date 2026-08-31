import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import CitySelector from "@/components/CitySelector";
import MusicSelector from "@/components/MusicSelector";

import { cities, musicGenres } from "@/constants/nightlifeData";

export default function HomeScreen() {
  const [selectedCity, setSelectedCity] = useState("");
  const [selectedMusic, setSelectedMusic] = useState<string[]>([]);

  function toggleMusic(genre: string) {
    if (selectedMusic.includes(genre)) {
      setSelectedMusic(selectedMusic.filter((music) => music !== genre));
    } else {
      setSelectedMusic([...selectedMusic, genre]);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Gde idemo večeras?</Text>

      <Text style={styles.subtitle}>Pronađi najbolje mesto za izlazak.</Text>

      <Text style={styles.sectionTitle}>Selektuj grad</Text>

      <CitySelector
        cities={cities}
        selectedCity={selectedCity}
        onSelectCity={setSelectedCity}
      />

      <Text style={styles.sectionTitle}>Koju muziku voliš?</Text>

      <MusicSelector
        genres={musicGenres}
        selectedMusic={selectedMusic}
        onToggleMusic={toggleMusic}
      />

      <View style={styles.selectionBox}>
        <Text style={styles.selectionTitle}>Tvoj izbor</Text>

        <Text style={styles.selectionText}>
          Grad: {selectedCity || "nije izabran"}
        </Text>

        <Text style={styles.selectionText}>
          Muzika:{" "}
          {selectedMusic.length > 0
            ? selectedMusic.join(", ")
            : "nije izabrana"}
        </Text>
      </View>
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

  selectionBox: {
    width: "100%",
    maxWidth: 500,
    marginTop: 30,
    padding: 20,
    borderRadius: 12,
    backgroundColor: "#eee",
  },

  selectionTitle: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 10,
  },

  selectionText: {
    fontSize: 16,
    marginVertical: 4,
  },
});
