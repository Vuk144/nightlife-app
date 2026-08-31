import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

type MusicSelectorProps = {
  genres: string[];
  selectedMusic: string[];
  onToggleMusic: (genre: string) => void;
};

export default function MusicSelector({
  genres,
  selectedMusic,
  onToggleMusic,
}: MusicSelectorProps) {
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
});
