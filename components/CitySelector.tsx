import { useState } from "react";

import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

type CitySelectorProps = {
  cities: string[];
  selectedCity: string;
  onSelectCity: (city: string) => void;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
};

export default function CitySelector({
  cities,
  selectedCity,
  onSelectCity,
  isOpen,
  onOpen,
  onClose,
}: CitySelectorProps) {
  const [searchText, setSearchText] = useState("");

  const filteredCities = cities.filter((city) =>
    city.toLowerCase().includes(searchText.toLowerCase()),
  );

  function selectCity(city: string) {
    onSelectCity(city);
    setSearchText(city);
    onClose();
  }

  function clearCity() {
    onSelectCity("");
    setSearchText("");
  }

  function handleBlur() {
    setTimeout(() => {
      onClose();
    }, 150);
  }

  return (
    <View style={[styles.selector, { zIndex: isOpen ? 20 : 1 }]}>
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          placeholder="Pretraži grad..."
          value={searchText}
          onChangeText={(text) => {
            setSearchText(text);
            onOpen();
          }}
          onFocus={onOpen}
          onBlur={handleBlur}
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
            <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
              {filteredCities.map((city) => (
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
              ))}
            </ScrollView>
          ) : (
            <Text style={styles.noResults}>Nema pronađenih gradova.</Text>
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
    position: "relative",
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
    position: "absolute",
    top: 55,
    left: 0,
    right: 0,
    maxHeight: 220,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    backgroundColor: "#fff",
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
});
