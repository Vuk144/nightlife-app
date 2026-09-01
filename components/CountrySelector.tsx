import { useState } from "react";

import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Country } from "@/constants/locations";

type CountrySelectorProps = {
  countries: Country[];
  selectedCountry: string;
  onSelectCountry: (countryId: string) => void;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
};

export default function CountrySelector({
  countries,
  selectedCountry,
  onSelectCountry,
  isOpen,
  onOpen,
  onClose,
}: CountrySelectorProps) {
  const [searchText, setSearchText] = useState("");

  const filteredCountries = countries.filter((country) =>
    country.name.toLowerCase().includes(searchText.toLowerCase()),
  );

  function selectCountry(country: Country) {
    onSelectCountry(country.id);
    setSearchText(country.name);
    onClose();
  }

  function clearCountry() {
    onSelectCountry("");
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
          placeholder="Search for a country..."
          value={searchText}
          onChangeText={(text) => {
            setSearchText(text);
            onOpen();
          }}
          onFocus={onOpen}
          onBlur={handleBlur}
        />

        {selectedCountry !== "" && (
          <Pressable style={styles.clearSmallButton} onPress={clearCountry}>
            <Text style={styles.clearSmallText}>✕</Text>
          </Pressable>
        )}
      </View>

      {isOpen && (
        <View style={styles.dropdown}>
          {filteredCountries.length > 0 ? (
            <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
              {filteredCountries.map((country) => (
                <Pressable
                  key={country.id}
                  style={[
                    styles.dropdownItem,
                    selectedCountry === country.id &&
                      styles.selectedDropdownItem,
                  ]}
                  onPress={() => selectCountry(country)}
                >
                  <Text style={styles.dropdownItemText}>{country.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : (
            <Text style={styles.noResults}>No countries found.</Text>
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
