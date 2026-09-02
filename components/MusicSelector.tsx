import { useRef, useState } from "react";

import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";

const DROPDOWN_MAX_HEIGHT = 220;

type Anchor = {
  left: number;
  width: number;
  inputTop: number;
  dropdownTop?: number;
  dropdownBottom?: number;
};

type MusicSelectorProps = {
  genres: string[];
  selectedMusic: string[];
  onToggleMusic: (genre: string) => void;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onBackButtonPress: () => void;
};

export default function MusicSelector({
  genres,
  selectedMusic,
  onToggleMusic,
  isOpen,
  onOpen,
  onClose,
  onBackButtonPress,
}: MusicSelectorProps) {
  const [searchText, setSearchText] = useState("");
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const inputContainerRef = useRef<View>(null);
  const modalInputRef = useRef<TextInput>(null);
  const { height: windowHeight } = useWindowDimensions();

  const filteredGenres = genres.filter((genre) =>
    genre.toLowerCase().includes(searchText.toLowerCase()),
  );

  // Measures the closed-state input's on-screen position so the Modal (the
  // active search input while open, plus the dropdown list) can be placed at
  // the same spot. Opens the dropdown upward instead when there isn't enough
  // room below on screen.
  function openDropdown() {
    inputContainerRef.current?.measureInWindow((x, y, width, height) => {
      const spaceBelow = windowHeight - (y + height);
      const spaceAbove = y;
      const openUpward =
        spaceBelow < DROPDOWN_MAX_HEIGHT && spaceAbove > spaceBelow;

      setAnchor({
        left: x,
        width,
        inputTop: y,
        dropdownTop: openUpward ? undefined : y + height,
        dropdownBottom: openUpward ? windowHeight - y : undefined,
      });
    });
    onOpen();
  }

  return (
    <View style={styles.selector}>
      {/* Closed-state row: a plain Pressable, not a TextInput — nothing
          here is focusable, so there's no Autofill-capable field and no
          stale-focus state to worry about between opens. The active,
          typable input lives inside the Modal below while open. */}
      <View style={styles.inputContainer} ref={inputContainerRef}>
        <Pressable style={styles.closedInputPressable} onPress={openDropdown}>
          <Text
            style={[
              styles.closedInputText,
              searchText === "" && styles.closedInputPlaceholder,
            ]}
          >
            {searchText || "Search for music..."}
          </Text>
        </Pressable>

        {searchText !== "" && (
          <Pressable
            style={styles.clearSmallButton}
            onPress={() => setSearchText("")}
          >
            <Text style={styles.clearSmallText}>✕</Text>
          </Pressable>
        )}
      </View>

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

      {/* Rendered in a Modal so the dropdown's own ScrollView is never a
          descendant of the page's ScrollView — no nested same-direction
          scroll gesture to contend with. Also gives the active search input
          the same window as the dropdown, so opening it doesn't steal the
          keyboard away from a focused input outside the Modal. */}
      <Modal
        visible={isOpen}
        transparent
        animationType="none"
        onRequestClose={onBackButtonPress}
        onShow={() => modalInputRef.current?.focus()}
      >
        {/* Full-screen backdrop: behind the input row and dropdown box
            (rendered first, so they paint on top and get first claim on
            touches inside their own bounds), but catches every tap
            outside them. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        {anchor && (
          <>
            <View
              style={[
                styles.inputContainer,
                styles.modalInputContainer,
                { top: anchor.inputTop, left: anchor.left, width: anchor.width },
              ]}
            >
              <TextInput
                ref={modalInputRef}
                style={styles.input}
                placeholder="Search for music..."
                value={searchText}
                onChangeText={setSearchText}
              />

              {searchText !== "" && (
                <Pressable
                  style={styles.clearSmallButton}
                  onPress={() => setSearchText("")}
                >
                  <Text style={styles.clearSmallText}>✕</Text>
                </Pressable>
              )}
            </View>

            <View
              style={[
                styles.dropdown,
                {
                  top: anchor.dropdownTop,
                  bottom: anchor.dropdownBottom,
                  left: anchor.left,
                  width: anchor.width,
                },
              ]}
            >
              {filteredGenres.length > 0 ? (
                <ScrollView
                  keyboardShouldPersistTaps="handled"
                  style={styles.dropdownScroll}
                >
                  {filteredGenres.map((genre) => {
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
                  })}
                </ScrollView>
              ) : (
                <Text style={styles.noResults}>No genres found.</Text>
              )}
            </View>
          </>
        )}
      </Modal>
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

  modalInputContainer: {
    position: "absolute",
  },

  input: {
    flex: 1,
    paddingHorizontal: 15,
    paddingVertical: 14,
    fontSize: 16,
  },

  closedInputPressable: {
    flex: 1,
    paddingHorizontal: 15,
    paddingVertical: 14,
  },

  closedInputText: {
    fontSize: 16,
    color: "#000",
  },

  closedInputPlaceholder: {
    color: "#999",
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
    maxHeight: DROPDOWN_MAX_HEIGHT,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    backgroundColor: "#fff",
    overflow: "hidden",
  },

  dropdownScroll: {
    maxHeight: DROPDOWN_MAX_HEIGHT,
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
