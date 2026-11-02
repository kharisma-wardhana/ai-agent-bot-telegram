import type { Skill } from "./index";

export const ringkasMateri: Skill = {
  name: "ringkas-materi",
  description: "Meringkas materi menjadi poin-poin inti.",
  triggers: [/\b(ringkas|rangkum|ringkasan|rangkuman|summary|intinya|poin penting|garis besar)\b/i],
  instructions: "Ringkas materi yang ditanyakan menjadi 3–5 poin bernomor yang pendek. Setiap poin satu kalimat.",
};
