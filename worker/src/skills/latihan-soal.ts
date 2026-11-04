import type { Skill } from "./index";

export const latihanSoal: Skill = {
  name: "latihan-soal",
  description: "Membuat soal latihan singkat dari materi.",
  triggers: [/\b(soal|latihan|quiz|kuis|uji aku|tes aku|test me)\b/i],
  instructions: "Buat 2 soal latihan singkat (pilihan ganda A–C) dari materi di dokumen, lalu tulis kunci jawabannya di baris terakhir dengan format 'Kunci: 1-B, 2-A'.",
};
