import { LlmError, type ChatRequest, type ChatResult, type LlmBackend, type OnDelta } from "./types";

export type Route = { backend: LlmBackend } | { deferred: true; reason: "images_need_kaggle" };

/**
 * Picks Kaggle when its heartbeat is fresh, Workers AI otherwise (spec › Availability).
 * Image requests need Kaggle; when it is offline they are deferred, not downgraded.
 */
export class LlmRouter {
  private cached: { at: number; online: boolean } | null = null;

  constructor(
    private readonly primary: LlmBackend,
    private readonly fallback: LlmBackend,
    private readonly heartbeatAgeSeconds: () => Promise<number | null>,
    private readonly maxAgeSeconds: number,
    private readonly now: () => number = Date.now,
    private readonly cacheMs = 10_000,
  ) {}

  async primaryOnline(): Promise<boolean> {
    const t = this.now();
    if (this.cached && t - this.cached.at < this.cacheMs) return this.cached.online;
    let online = false;
    try {
      const age = await this.heartbeatAgeSeconds();
      online = age !== null && age <= this.maxAgeSeconds;
    } catch {
      online = false;
    }
    this.cached = { at: t, online };
    return online;
  }

  /** Marks the primary offline until the next heartbeat check window. */
  markPrimaryDown() {
    this.cached = { at: this.now(), online: false };
  }

  async route(needsImages: boolean): Promise<Route> {
    if (await this.primaryOnline()) return { backend: this.primary };
    if (needsImages && !this.fallback.supportsImages) return { deferred: true, reason: "images_need_kaggle" };
    return { backend: this.fallback };
  }

  /**
   * Chats on the routed backend. If Kaggle fails mid-request on a text request, retries once on
   * Workers AI so the learner sees no error (AC 18). Throws LlmError when images need Kaggle and it failed.
   */
  async chat(req: ChatRequest, needsImages: boolean, onDelta?: OnDelta, onRetry?: () => void | Promise<void>): Promise<ChatResult> {
    const r = await this.route(needsImages);
    if ("deferred" in r) throw new LlmError("images need the Kaggle backend, which is offline", "kaggle");
    try {
      return await r.backend.chat(req, onDelta);
    } catch (e) {
      if (r.backend !== this.primary || needsImages) throw e;
      this.markPrimaryDown();
      await onRetry?.();
      return this.fallback.chat(req, onDelta);
    }
  }
}
