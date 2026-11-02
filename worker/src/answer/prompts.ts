import type { ChunkMatch, Turn } from "../db/repository";
import type { ChatMessage, ContentPart } from "../llm/types";
import { personaSystemPrompt } from "./persona";

const TAGS = ["dokumen", "memori", "pertanyaan", "riwayat"];

/** Neutralises our data-delimiting tags inside untrusted text so it can't break out of its block. */
export function sanitizeData(text: string): string {
  let t = text;
  for (const tag of TAGS) t = t.replace(new RegExp(`</?\\s*${tag}\\s*>`, "gi"), (m) => m.replace(/</g, "‹").replace(/>/g, "›"));
  return t;
}

export function documentsBlock(chunks: ChunkMatch[]): string {
  if (chunks.length === 0) return "<dokumen>\n(tidak ada dokumen yang relevan)\n</dokumen>";
  const body = chunks.map((c, i) => `[${i + 1}] (${sanitizeData(c.title)})\n${sanitizeData(c.content)}`).join("\n\n");
  return `<dokumen>\n${body}\n</dokumen>`;
}

export interface PromptInput {
  question: string;
  chunks: ChunkMatch[];
  history?: Turn[];
  memoryNotes?: string[];
  skillInstructions?: string;
  imageDataUrl?: string;
  maxChars: number;
}

/** Builds the chat messages: persona (+ skill) as system, prior turns, then one user message of tagged data. */
export function buildMessages(p: PromptInput): ChatMessage[] {
  const system = p.skillInstructions ? `${personaSystemPrompt(p.maxChars)}\n\nGaya jawaban untuk pertanyaan ini:\n${p.skillInstructions}` : personaSystemPrompt(p.maxChars);
  const msgs: ChatMessage[] = [{ role: "system", content: system }];
  for (const t of p.history ?? []) {
    msgs.push(t.role === "user" ? { role: "user", content: `<pertanyaan>\n${sanitizeData(t.content)}\n</pertanyaan>` } : { role: "assistant", content: t.content });
  }
  const memory = p.memoryNotes?.length ? `\n<memori>\n${p.memoryNotes.map(sanitizeData).join("\n")}\n</memori>` : "";
  const text = `${documentsBlock(p.chunks)}${memory}\n<pertanyaan>\n${sanitizeData(p.question)}\n</pertanyaan>`;
  if (p.imageDataUrl) {
    const parts: ContentPart[] = [{ type: "text", text }, { type: "image_url", image_url: { url: p.imageDataUrl } }];
    msgs.push({ role: "user", content: parts });
  } else {
    msgs.push({ role: "user", content: text });
  }
  return msgs;
}

/** Messages for the single "compress to ≤ N chars" pass. */
export function compressionMessages(text: string, targetChars: number): ChatMessage[] {
  return [
    { role: "system", content: `Ringkas teks berikut menjadi maksimal ${targetChars} karakter dalam Bahasa Indonesia. Pertahankan makna dan sapaan "kamu". Keluarkan hanya teks ringkasannya.` },
    { role: "user", content: sanitizeData(text) },
  ];
}
