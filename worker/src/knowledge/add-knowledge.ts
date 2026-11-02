import type { Deps } from "../deps";
import { chunk, contentHash, normalize } from "../rag/chunker";
import type { BotEvent } from "../telegram/parse-update";

export const MSG = {
  refused: "Maaf, perintah /add_knowledge hanya untuk mentor yang terdaftar. 🙏",
  usage: "Cara pakai: kirim /add_knowledge diikuti teks materi, atau lampirkan file .md, .txt, .pdf, atau .html dengan caption /add_knowledge.",
  unsupported: "Format file belum didukung. Kirim .md, .txt, .pdf, atau .html ya.",
  received: "📥 Materi diterima, sedang diproses…",
  duplicate: "ℹ️ Materi ini sudah ada di basis pengetahuan, tidak ada yang ditambahkan.",
  done: (n: number, title: string) => `✅ Selesai: ${n} potongan materi dari "${title}" ditambahkan ke lesson-docs.`,
  queued: (online: boolean) =>
    online
      ? "⏳ File PDF/HTML diproses di server pengolahan. Aku kabari jumlah potongan yang ditambahkan setelah selesai."
      : "⏳ Server pengolahan PDF/HTML sedang offline. File sudah disimpan dan akan diproses otomatis saat server online; aku kabari setelah selesai.",
  failed: "⚠️ Gagal memproses materi. Coba lagi sebentar lagi.",
};

const TEXT_EXT = new Set(["md", "txt"]);
const QUEUED_EXT = new Set(["pdf", "html", "htm"]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function extOf(fileName: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(fileName);
  return m ? m[1]!.toLowerCase() : "";
}

function safeName(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "file";
}

function titleFromText(text: string): string {
  const first = normalize(text).split("\n")[0] ?? "";
  const t = first.replace(/^#+\s*/, "").trim();
  return (t.length > 60 ? `${t.slice(0, 57)}…` : t) || "Materi tambahan";
}

async function addText(d: Deps, mentorId: number, text: string, title: string, sourceType: "text" | "md" | "txt", r2Key: string | null): Promise<string> {
  const pieces = chunk(text);
  if (pieces.length === 0) return MSG.usage;
  const vectors = await d.embedder.embed(pieces);
  const res = await d.repo.insertKnowledge(
    { title, sourceType, origin: "add_knowledge", addedBy: mentorId, r2Key, contentHash: await contentHash(text) },
    pieces.map((content, position) => ({ position, content, embedding: vectors[position]! })),
  );
  return res.sourceId ? MSG.done(res.chunksAdded, title) : MSG.duplicate;
}

/** /add_knowledge: whitelisted mentors append text or a file to lesson-docs (AC 13, 14). */
export async function handleAddKnowledge(d: Deps, e: Extract<BotEvent, { kind: "add_knowledge" }>): Promise<void> {
  const to = e.from.id;
  if (!d.cfg.knowledgeWhitelistIds.includes(e.from.id)) {
    await d.tg.sendMessage(to, MSG.refused);
    return;
  }
  if (!e.text && !e.document) {
    await d.tg.sendMessage(to, MSG.usage);
    return;
  }

  try {
    if (!e.document) {
      await d.tg.sendMessage(to, MSG.received);
      await d.tg.sendMessage(to, await addText(d, e.from.id, e.text!, titleFromText(e.text!), "text", null));
      return;
    }

    const ext = extOf(e.document.fileName);
    if (!TEXT_EXT.has(ext) && !QUEUED_EXT.has(ext)) {
      await d.tg.sendMessage(to, MSG.unsupported);
      return;
    }
    await d.tg.sendMessage(to, MSG.received);
    const { bytes } = await d.tg.downloadFile(e.document.fileId, MAX_FILE_BYTES);
    const day = new Date(d.now()).toISOString().slice(0, 10);
    const r2Key = `knowledge/${day}/${crypto.randomUUID()}-${safeName(e.document.fileName)}`;
    await d.env.KNOWLEDGE_BUCKET.put(r2Key, bytes, {
      customMetadata: { addedBy: String(e.from.id), fileName: e.document.fileName.slice(0, 200) },
    });

    if (TEXT_EXT.has(ext)) {
      const text = new TextDecoder().decode(bytes);
      const title = ext === "md" ? titleFromText(text) : e.document.fileName.replace(/\.[^.]+$/, "");
      await d.tg.sendMessage(to, await addText(d, e.from.id, text, title, ext as "md" | "txt", r2Key));
      return;
    }

    await d.repo.createIngestJob({ r2Key, fileName: e.document.fileName, sourceType: ext === "pdf" ? "pdf" : "html", requestedBy: e.from.id });
    await d.tg.sendMessage(to, MSG.queued(await d.router.primaryOnline()));
  } catch (err) {
    console.error("add_knowledge failed", (err as Error).message);
    await d.tg.sendMessage(to, MSG.failed).catch(() => undefined);
  }
}
