/**
 * Cohort welcome: batched group welcome for new members, leave notices to dashboard users
 * (docs/cohort-welcome-message/spec.md).
 */
import type { WelcomeSettings } from "../db/repository";
import type { Deps } from "../deps";
import { displayName } from "../telegram/parse-update";
import type { MessageEntity } from "../telegram/client";
import type { TgUser } from "../telegram/types";

export const TEMPLATE_MAX = 1000;
export const BATCH_SIZE = 50;

export const DEFAULT_TEMPLATE = [
  "Halo {nama}! 👋 Selamat datang di grup cohort. Aku Kak Skilly, asisten belajar kalian di sini.",
  "",
  "Biar lancar:",
  "1. Baca dulu topik aturan grup ya.",
  "2. Tekan Start di {bot} supaya aku bisa membalas pertanyaanmu lewat DM.",
  "3. Ada pertanyaan soal materi? Tulis di topik mana saja dengan tagar #askAI.",
  "",
  "Semangat belajar! 🚀",
].join("\n");

export const DEFAULT_SETTINGS: WelcomeSettings = {
  template: DEFAULT_TEMPLATE, topicId: null, welcomeEnabled: true, leaveEnabled: true, updatedBy: null, updatedAt: null,
};

/** Saved settings, or the built-in defaults when nothing has been saved yet (AC 8). */
export async function loadSettings(d: Deps): Promise<WelcomeSettings> {
  return (await d.repo.getWelcomeSettings()) ?? DEFAULT_SETTINGS;
}

/** Dashboard users = config owners ∪ active added users, each Telegram ID once (spec › When someone leaves). */
export async function dashboardUserIds(d: Deps): Promise<number[]> {
  const ids = d.cfg.dashboardOwners.map((o) => o.telegramId);
  try {
    ids.push(...(await d.repo.listDashboardUsers()).map((u) => u.telegramId));
  } catch (e) {
    console.error("dashboard users unavailable for leave notice", (e as Error).message);
  }
  return [...new Set(ids)];
}

export function memberName(u: TgUser): string {
  return displayName(u).trim().slice(0, 64) || String(u.id);
}

export function leaveNoticeText(u: TgUser, kicked: boolean): string {
  const who = `${memberName(u)}${u.username ? ` (@${u.username})` : ""}`;
  return `👋 ${who} ${kicked ? "dikeluarkan dari" : "keluar dari"} grup cohort.`;
}

// ---------- Rendering and posting the batch (AC 3, 4, 8, 11) ----------
export interface Newcomer { id: number; name: string }

/** "Ani", "Ani dan Budi", "Ani, Budi, dan Citra": with each name's [start, end) inside the joined string. */
function joinNames(people: Newcomer[]): { text: string; spans: { id: number; name: string; start: number }[] } {
  let text = "";
  const spans: { id: number; name: string; start: number }[] = [];
  people.forEach((p, i) => {
    if (i > 0) text += people.length === 2 ? " dan " : i === people.length - 1 ? ", dan " : ", ";
    spans.push({ id: p.id, name: p.name, start: text.length });
    text += p.name;
  });
  return { text, spans };
}

/**
 * Fills the template: {bot} → @username, every {nama} → the newcomers, each a text_mention.
 * Plain text: the template is sent verbatim apart from the placeholders, never with parse_mode.
 * Offsets are UTF-16 code units, which is JS string indexing (what Telegram expects).
 */
export function renderWelcome(template: string, people: Newcomer[], botUsername: string): { text: string; entities: MessageEntity[] } {
  const names = joinNames(people);
  const parts = template.replace(/\{bot\}/g, `@${botUsername}`).split("{nama}");
  let text = "";
  const entities: MessageEntity[] = [];
  parts.forEach((part, i) => {
    text += part;
    if (i === parts.length - 1) return;
    for (const s of names.spans) {
      entities.push({ type: "text_mention", offset: text.length + s.start, length: s.name.length, user: { id: s.id, is_bot: false, first_name: s.name } });
    }
    text += names.text;
  });
  return { text, entities };
}

const MAX_BATCHES_PER_RUN = 10;

/**
 * Cron job: posts the waiting newcomers, 50 per message, into the welcome topic. Taking the list is atomic,
 * so overlapping runs can't double-post. With welcomes switched off, waiting rows are dropped, not posted.
 * A failed send puts that batch back for the next run.
 */
export async function postPendingWelcomes(d: Deps): Promise<number> {
  const s = await loadSettings(d);
  let posted = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const batch = await d.repo.takePendingWelcomes(BATCH_SIZE);
    if (batch.length === 0) break;
    if (!s.welcomeEnabled) continue;
    const { text, entities } = renderWelcome(s.template, batch.map((b) => ({ id: b.telegramId, name: b.displayName })), d.cfg.botUsername);
    try {
      await d.tg.sendMessage(d.cfg.groupChatId, text, { threadId: s.topicId ?? undefined, entities });
      posted += batch.length;
    } catch (e) {
      console.error("welcome post failed; re-queueing batch", (e as Error).message);
      for (const b of batch) await d.repo.queueWelcome(b.telegramId, b.displayName);
      break;
    }
  }
  return posted;
}

/** A join only queues the newcomer; the cron posts the batch (AC 1). Off switch = not queued (AC 7). */
export async function handleMemberJoin(d: Deps, u: TgUser): Promise<void> {
  const s = await loadSettings(d);
  if (!s.welcomeEnabled) return;
  await d.repo.queueWelcome(u.id, memberName(u));
}

/** A leave drops any pending welcome and DMs every dashboard user once (AC 5, 6, 7). Nothing goes to the group. */
export async function handleMemberLeave(d: Deps, u: TgUser, kicked: boolean): Promise<void> {
  await d.repo.unqueueWelcome(u.id);
  const s = await loadSettings(d);
  if (!s.leaveEnabled) return;
  const text = leaveNoticeText(u, kicked);
  for (const id of await dashboardUserIds(d)) {
    try {
      await d.tg.sendMessage(id, text);
    } catch (e) {
      console.error(`leave notice to ${id} failed`, (e as Error).message);
    }
  }
}
