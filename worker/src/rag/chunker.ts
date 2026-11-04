/**
 * Text normalisation and chunking for /add_knowledge text. Must stay identical to
 * ingest/src/ingest/chunker.py (both are checked against ingest/tests/fixtures/chunk_case.json).
 * Note: lengths are UTF-16 code units here vs code points in Python; they only differ for
 * astral characters (e.g. emoji), which shifts a chunk boundary but never loses text.
 */

export const CHUNK_SIZE = 800;
export const CHUNK_OVERLAP = 150;

export function normalize(text: string): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v]+/g, " ").trim());
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalize(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function pieces(paragraph: string, size: number): string[] {
  if (paragraph.length <= size) return [paragraph];
  const out: string[] = [];
  for (let sentence of paragraph.split(/(?<=[.!?])\s+/)) {
    while (sentence.length > size) {
      out.push(sentence.slice(0, size));
      sentence = sentence.slice(size);
    }
    if (sentence) out.push(sentence);
  }
  return out;
}

function overlapTail(prev: string, overlap: number): string {
  if (overlap <= 0) return "";
  const tail = prev.slice(-overlap);
  const i = tail.indexOf(" ");
  return i >= 0 ? tail.slice(i + 1) : tail;
}

export function chunk(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const norm = normalize(text);
  if (!norm) return [];
  const all: string[] = [];
  for (const para of norm.split("\n\n")) all.push(...pieces(para, size));

  const chunks: string[] = [];
  let current = "";
  for (const piece of all) {
    const candidate = current ? `${current}\n\n${piece}` : piece;
    if (candidate.length <= size) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      const tail = overlapTail(current, overlap);
      current = tail && tail.length + 2 + piece.length <= size ? `${tail}\n\n${piece}` : piece;
    } else {
      current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
