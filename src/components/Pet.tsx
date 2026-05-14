import type { PetState, PetType } from "../types";
import { BREED_BY_ID, BREED_IDS } from "../assets/breeds";

const STATE_PNGS = import.meta.glob<{ default: string }>(
  "../assets/pets/*.png",
  { eager: true },
);

function urlForState(breedId: string, state: PetState): string {
  const key = `../assets/pets/${breedId}_${state}.png`;
  return STATE_PNGS[key]?.default ?? "";
}

function fallbackBreedId(animal: string): string {
  let h = 0;
  for (let i = 0; i < animal.length; i++) {
    h = (h * 31 + animal.charCodeAt(i)) | 0;
  }
  return BREED_IDS[Math.abs(h) % BREED_IDS.length];
}

const ANIM_CLASS: Record<PetState, string> = {
  sleeping:     "pet-anim-sleeping",
  typing:       "pet-anim-typing",
  surprised:    "pet-anim-surprised",
  disappointed: "pet-anim-disappointed",
  relieved:     "pet-anim-relieved",
};

interface PetProps {
  animal: PetType;
  state: PetState;
  size?: "lg" | "md" | "sm";
}

export function Pet({ animal, state, size = "lg" }: PetProps) {
  const dim = size === "lg" ? 80 : size === "md" ? 48 : 32;
  const breedId = BREED_BY_ID[animal] ? animal : fallbackBreedId(animal);
  const spec = BREED_BY_ID[breedId];
  const src = urlForState(breedId, state);
  const alt = spec ? `${spec.label} ${state}` : state;

  return (
    <div
      className={`relative ${ANIM_CLASS[state]}`}
      style={{ width: dim, height: dim }}
      title="우클릭으로 펫 변경"
    >
      <img
        src={src}
        alt={alt}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          transition: "opacity 0.2s",
          display: "block",
        }}
        draggable={false}
      />
    </div>
  );
}
