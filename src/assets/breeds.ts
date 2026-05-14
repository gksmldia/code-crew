export type BreedId =
  | "golden_retriever"
  | "shiba_inu"
  | "beagle"
  | "yorkshire_terrier"
  | "pomeranian"
  | "border_collie"
  | "welsh_corgi"
  | "dalmatian"
  | "siberian_husky"
  | "french_bulldog"
  | "black_cat"
  | "calico"
  | "maine_coon"
  | "munchkin"
  | "orange_tabby"
  | "persian"
  | "russian_blue"
  | "scottish_fold"
  | "siamese"
  | "tuxedo_cat";

export interface BreedSpec {
  id: BreedId;
  label: string;
}

export const BREEDS: BreedSpec[] = [
  { id: "golden_retriever",  label: "Golden Retriever" },
  { id: "shiba_inu",         label: "Shiba Inu" },
  { id: "beagle",            label: "Beagle" },
  { id: "yorkshire_terrier", label: "Yorkshire Terrier" },
  { id: "pomeranian",        label: "Pomeranian" },
  { id: "border_collie",     label: "Border Collie" },
  { id: "welsh_corgi",       label: "Welsh Corgi" },
  { id: "dalmatian",         label: "Dalmatian" },
  { id: "siberian_husky",    label: "Siberian Husky" },
  { id: "french_bulldog",    label: "French Bulldog" },
  { id: "black_cat",         label: "Black Cat" },
  { id: "calico",            label: "Calico" },
  { id: "maine_coon",        label: "Maine Coon" },
  { id: "munchkin",          label: "Munchkin" },
  { id: "orange_tabby",      label: "Orange Tabby" },
  { id: "persian",           label: "Persian" },
  { id: "russian_blue",      label: "Russian Blue" },
  { id: "scottish_fold",     label: "Scottish Fold" },
  { id: "siamese",           label: "Siamese" },
  { id: "tuxedo_cat",        label: "Tuxedo Cat" },
];

export const BREED_IDS: BreedId[] = BREEDS.map((b) => b.id);

export const BREED_BY_ID: Record<string, BreedSpec> = Object.fromEntries(
  BREEDS.map((b) => [b.id, b]),
);

export function isBreedId(s: string): s is BreedId {
  return s in BREED_BY_ID;
}
