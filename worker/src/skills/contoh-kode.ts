import type { Skill } from "./index";

export const contohKode: Skill = {
  name: "contoh-kode",
  description: "Memberi contoh kode atau prompt singkat yang bisa langsung dicoba.",
  triggers: [/\b(kode|code|coding|ngoding|python|javascript|script|program|snippet|contoh prompt)\b/i],
  instructions: "Beri satu contoh singkat (kode atau prompt) yang relevan dengan materi, maksimal 8 baris, lalu jelaskan tiap bagian penting dalam 1–2 kalimat. Jangan membuat contoh yang tidak didukung dokumen.",
};
