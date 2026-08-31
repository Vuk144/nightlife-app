import { useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

const cities = [
  "Beograd",
  "Novi Sad",
  "Niš",
  "Kragujevac",
  "Subotica",
  "Pančevo",
  "Čačak",
  "Zrenjanin",
  "Sombor",
  "Kraljevo",
  "Užice",
  "Leskovac",
  "Novi Pazar",
  "Šabac",
  "Valjevo",
  "Budimpešta",
  "Beč",
  "Prag",
  "Berlin",
  "Minhen",
  "Pariz",
  "London",
  "Amsterdam",
  "Brisel",
  "Barselona",
  "Madrid",
  "Lisabon",
  "Milano",
  "Rim",
  "Atina",
  "Solun",
  "Istanbul",
  "Zagreb",
  "Ljubljana",
  "Sarajevo",
  "Podgorica",
  "Skoplje",
];

const musicGenres = [
  "Techno",
  "House",
  "Deep House",
  "Tech House",
  "Progressive House",
  "Minimal",
  "Melodic Techno",
  "Hard Techno",
  "Trance",
  "Psytrance",
  "Drum and Bass",
  "Dubstep",
  "Garage",
  "UK Garage",
  "Breakbeat",
  "Jungle",
  "Electro",
  "Disco",
  "Funk",
  "R&B",
  "Hip-Hop",
  "Rap",
  "Trap",
  "Pop",
  "Rock",
  "Indie Rock",
  "Alternative Rock",
  "Metal",
  "Punk",
  "Jazz",
  "Blues",
  "Reggae",
  "Dancehall",
  "Afrobeats",
  "Latin",
  "Reggaeton",
  "Salsa",
  "Balkan",
  "Domaće",
  "Narodna",
  "Turbo Folk",
  "Ex-Yu Rock",
  "Akustična muzika",
];

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

function CitySelector({
  cities,
  selectedCity,
  onSelectCity,
}: {
  cities: string[];
  selectedCity: string;
  onSelectCity: (city: string) => void;
}) {
  const [searchText, setSearchText] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const filteredCities = cities.filter((city) =>
    city.toLowerCase().includes(searchText.toLowerCase()),
  );

  function selectCity(city: string) {
    onSelectCity(city);
    setSearchText(city);
    setIsOpen(false);
  }

  function clearCity() {
    onSelectCity("");
    setSearchText("");
  }

  return (
    <View style={styles.selector}>
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          placeholder="Pretraži grad..."
          value={searchText}
          onChangeText={(text) => {
            setSearchText(text);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
        />

        {selectedCity !== "" && (
          <Pressable style={styles.clearSmallButton} onPress={clearCity}>
            <Text style={styles.clearSmallText}>✕</Text>
          </Pressable>
        )}
      </View>

      {isOpen && (
        <View style={styles.dropdown}>
          {filteredCities.length > 0 ? (
            filteredCities.map((city) => (
              <Pressable
                key={city}
                style={[
                  styles.dropdownItem,
                  selectedCity === city && styles.selectedDropdownItem,
                ]}
                onPress={() => selectCity(city)}
              >
                <Text style={styles.dropdownItemText}>{city}</Text>
              </Pressable>
            ))
          ) : (
            <Text style={styles.noResults}>Nema pronađenih gradova.</Text>
          )}
        </View>
      )}
    </View>
  );
}

function MusicSelector({
  genres,
  selectedMusic,
  onToggleMusic,
}: {
  genres: string[];
  selectedMusic: string[];
  onToggleMusic: (genre: string) => void;
}) {
  const [searchText, setSearchText] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const filteredGenres = genres.filter((genre) =>
    genre.toLowerCase().includes(searchText.toLowerCase()),
  );

  function handleInputPress() {
    setIsOpen(!isOpen);
  }

  return (
    <View style={styles.selector}>
      <Pressable style={styles.inputContainer} onPress={handleInputPress}>
        <TextInput
          style={styles.input}
          placeholder="Pretraži muziku..."
          value={searchText}
          onChangeText={(text) => {
            setSearchText(text);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
        />

        {searchText !== "" && (
          <Pressable
            style={styles.clearSmallButton}
            onPress={() => setSearchText("")}
          >
            <Text style={styles.clearSmallText}>✕</Text>
          </Pressable>
        )}
      </Pressable>

      {selectedMusic.length > 0 && (
        <View style={styles.selectedGenres}>
          {selectedMusic.map((genre) => (
            <Pressable
              key={genre}
              style={styles.genreTag}
              onPress={() => onToggleMusic(genre)}
            >
              <Text style={styles.genreTagText}>{genre} ✕</Text>
            </Pressable>
          ))}
        </View>
      )}

      {isOpen && (
        <View style={styles.dropdown}>
          {filteredGenres.length > 0 ? (
            filteredGenres.map((genre) => {
              const isSelected = selectedMusic.includes(genre);

              return (
                <Pressable
                  key={genre}
                  style={[
                    styles.dropdownItem,
                    isSelected && styles.selectedDropdownItem,
                  ]}
                  onPress={() => onToggleMusic(genre)}
                >
                  <Text style={styles.dropdownItemText}>
                    {isSelected ? "✓ " : ""}
                    {genre}
                  </Text>
                </Pressable>
              );
            })
          ) : (
            <Text style={styles.noResults}>Nema pronađenih žanrova.</Text>
          )}
        </View>
      )}
    </View>
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

  selector: {
    width: "100%",
    maxWidth: 500,
  },

  inputContainer: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 10,
    backgroundColor: "#fff",
  },

  input: {
    flex: 1,
    paddingHorizontal: 15,
    paddingVertical: 14,
    fontSize: 16,
  },

  clearSmallButton: {
    paddingHorizontal: 15,
  },

  clearSmallText: {
    fontSize: 18,
    color: "#777",
  },

  dropdown: {
    marginTop: 5,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    backgroundColor: "#fff",
    maxHeight: 220,
    overflow: "hidden",
  },

  dropdownItem: {
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },

  selectedDropdownItem: {
    backgroundColor: "#e8e8e8",
  },

  dropdownItemText: {
    fontSize: 16,
  },

  noResults: {
    padding: 15,
    textAlign: "center",
    color: "#777",
  },

  selectedGenres: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 10,
  },

  genreTag: {
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 20,
    backgroundColor: "#111",
  },

  genreTagText: {
    color: "#fff",
    fontSize: 14,
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
