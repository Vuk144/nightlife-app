export type Country = {
  id: string;
  name: string;
  cities: string[];
};

export const countries: Country[] = [
  {
    id: "RS",
    name: "Serbia",
    cities: [
      "Belgrade",
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
    ],
  },
  {
    id: "ES",
    name: "Spain",
    cities: ["Madrid", "Barcelona", "Valencia", "Seville", "Malaga"],
  },
  {
    id: "IT",
    name: "Italy",
    cities: ["Rome", "Milan", "Naples", "Turin", "Venice"],
  },
  {
    id: "DE",
    name: "Germany",
    cities: ["Berlin", "Munich", "Hamburg", "Cologne", "Frankfurt"],
  },
  {
    id: "AT",
    name: "Austria",
    cities: ["Vienna", "Salzburg", "Graz", "Innsbruck"],
  },
  {
    id: "FR",
    name: "France",
    cities: ["Paris", "Nice", "Lyon", "Marseille"],
  },
  {
    id: "HU",
    name: "Hungary",
    cities: ["Budapest", "Debrecen", "Szeged", "Pécs"],
  },
  {
    id: "CZ",
    name: "Czech Republic",
    cities: ["Prague", "Brno", "Ostrava", "Pilsen"],
  },
  {
    id: "HR",
    name: "Croatia",
    cities: ["Zagreb", "Split", "Rijeka", "Dubrovnik"],
  },
  {
    id: "SI",
    name: "Slovenia",
    cities: ["Ljubljana", "Maribor", "Kranj", "Celje"],
  },
  {
    id: "BA",
    name: "Bosnia and Herzegovina",
    cities: ["Sarajevo", "Banja Luka", "Mostar", "Tuzla"],
  },
  {
    id: "ME",
    name: "Montenegro",
    cities: ["Podgorica", "Budva", "Kotor", "Nikšić"],
  },
  {
    id: "MK",
    name: "North Macedonia",
    cities: ["Skopje", "Ohrid", "Bitola", "Tetovo"],
  },
  {
    id: "GR",
    name: "Greece",
    cities: ["Athens", "Thessaloniki", "Patras", "Heraklion"],
  },
  {
    id: "TR",
    name: "Turkey",
    cities: ["Istanbul", "Ankara", "Izmir", "Antalya"],
  },
  {
    id: "PT",
    name: "Portugal",
    cities: ["Lisbon", "Porto", "Coimbra", "Faro"],
  },
  {
    id: "NL",
    name: "Netherlands",
    cities: ["Amsterdam", "Rotterdam", "The Hague", "Utrecht"],
  },
  {
    id: "BE",
    name: "Belgium",
    cities: ["Brussels", "Antwerp", "Ghent"],
  },
  {
    id: "GB",
    name: "United Kingdom",
    cities: ["London", "Manchester", "Liverpool", "Edinburgh"],
  },
];
