export type Venue = {
  id: number;
  name: string;
  city: string;
  musicGenres: string[];
  closingTime: string;
  distance: number;
};

export const venues: Venue[] = [
  {
    id: 1,
    name: "Drugstore",
    city: "Beograd",
    musicGenres: ["Techno", "House", "Electro"],
    closingTime: "04:00",
    distance: 2.1,
  },
  {
    id: 2,
    name: "20/44",
    city: "Beograd",
    musicGenres: ["House", "Tech House", "Disco"],
    closingTime: "03:00",
    distance: 3.4,
  },
  {
    id: 3,
    name: "KST",
    city: "Beograd",
    musicGenres: ["Rock", "Domaće", "Alternative Rock"],
    closingTime: "02:00",
    distance: 1.8,
  },
  {
    id: 4,
    name: "GIGS",
    city: "Novi Sad",
    musicGenres: ["Techno", "House", "Tech House"],
    closingTime: "04:00",
    distance: 2.7,
  },
  {
    id: 5,
    name: "The Quarter",
    city: "Novi Sad",
    musicGenres: ["Rock", "Indie Rock", "Alternative Rock"],
    closingTime: "02:00",
    distance: 1.5,
  },
  {
    id: 6,
    name: "Paradise Garage",
    city: "Niš",
    musicGenres: ["House", "Techno", "Disco"],
    closingTime: "03:00",
    distance: 2.3,
  },
];
