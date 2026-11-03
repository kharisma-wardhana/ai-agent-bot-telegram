/**
 * Cohort welcome: batched group welcome for new members, leave notices to dashboard users
 * (docs/cohort-welcome-message/spec.md).
 */
import type { WelcomeSettings } from "../db/repository";
import type { Deps } from "../deps";
import { displayName } from "../telegram/parse-update";
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
