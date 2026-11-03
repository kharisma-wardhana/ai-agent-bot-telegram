/**
 * Follow-up actions for the dashboard: list, claim, release, image proxy
 * (docs/mentor-followup-dashboard/spec.md › The follow-up list, Claiming).
 */
import type { FollowupTab, FollowupView } from "../db/repository";
import type { Deps } from "../deps";
import { CLAIM_TTL_S, type DashUser } from "./auth";

export function listFollowups(d: Deps, tab: FollowupTab): Promise<FollowupView[]> {
  return d.repo.listFollowups(tab, CLAIM_TTL_S);
}

/** Exactly one concurrent claimer wins (AC 10); a lapsed claim can be taken over (AC 11). */
export function claimFollowup(d: Deps, user: DashUser, id: number) {
  return d.repo.claimFollowup(id, user.email, user.displayName, CLAIM_TTL_S);
}

export function releaseFollowup(d: Deps, user: DashUser, id: number): Promise<boolean> {
  return d.repo.releaseFollowup(id, user.email);
}

const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Streams the question's photo from Telegram. The bot token stays server-side; nothing is stored (AC 19).
 * Null when the follow-up has no photo or Telegram can't serve it.
 */
export async function followupImage(d: Deps, id: number): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  const fileId = await d.repo.followupPhoto(id);
  if (!fileId) return null;
  try {
    const { bytes, path } = await d.tg.downloadFile(fileId, MAX_IMAGE_BYTES);
    const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
    return { bytes, type: MIME[ext] ?? "image/jpeg" };
  } catch (e) {
    console.error("follow-up image fetch failed", (e as Error).message);
    return null;
  }
}
