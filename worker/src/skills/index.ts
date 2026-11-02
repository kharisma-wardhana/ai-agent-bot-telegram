import { contohKode } from "./contoh-kode";
import { jelaskanKonsep } from "./jelaskan-konsep";
import { latihanSoal } from "./latihan-soal";
import { ringkasMateri } from "./ringkas-materi";

export interface Skill {
  name: "jelaskan-konsep" | "contoh-kode" | "ringkas-materi" | "latihan-soal";
  description: string;
  triggers: RegExp[];
  instructions: string;
}

/** Order matters: the first skill whose trigger matches wins; jelaskan-konsep is the default. */
export const SKILLS: Skill[] = [latihanSoal, ringkasMateri, contohKode, jelaskanKonsep];

/** Picks the answer style for a question. Deterministic keyword match: no extra model call on the latency budget. */
export function selectSkill(question: string): Skill {
  return SKILLS.find((s) => s.triggers.some((t) => t.test(question))) ?? jelaskanKonsep;
}
