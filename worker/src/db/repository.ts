/**
 * Data access. Every operation is a SQL function (db/migrations/0002, 0003), called through an
 * RpcClient: PostgREST over HTTPS in production, PGlite in tests. Same SQL either way.
 */

export type Row = Record<string, unknown>;

export interface RpcClient {
  call(fn: string, args: Record<string, unknown>): Promise<Row[]>;
}

export class RepositoryError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** PostgREST RPC client for Supabase. The service key never appears in errors. */
export class SupabaseRpc implements RpcClient {
  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {}

  async call(fn: string, args: Record<string, unknown>): Promise<Row[]> {
    const res = await this.fetchFn(`${this.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: this.serviceKey,
        Authorization: `Bearer ${this.serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { message?: string };
        detail = body.message ?? "";
      } catch {
        /* non-JSON error body */
      }
      throw new RepositoryError(`rpc ${fn} failed (${res.status})${detail ? `: ${detail}` : ""}`, res.status);
    }
    const text = await res.text();
    if (!text) return [];
    return normalizeRows(fn, JSON.parse(text));
  }
}

/** PostgREST returns scalars for scalar/setof-scalar functions; normalise everything to rows. */
export function normalizeRows(fn: string, body: unknown): Row[] {
  const wrap = (v: unknown): Row => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Row) : { [fn]: v });
  if (Array.isArray(body)) return body.map(wrap);
  if (body === null || body === undefined) return [];
  return [wrap(body)];
}

// ---------- Domain types ----------
export interface ChunkMatch { id: number; sourceId: string; title: string; content: string; similarity: number }
export interface Learner { telegramId: number; hasStarted: boolean; privacyNoticeShown: boolean; isNew: boolean }
export interface OpenSession { id: string; originChatId: number | null; originThreadId: number | null; originMessageId: number | null; lastActivityAt: Date }
export type QuestionKind = "text" | "voice" | "photo";
export type AnswerSource = "lesson_docs" | "fallback";
export type Backend = "kaggle" | "workers_ai";
export interface TurnInput {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  questionKind?: QuestionKind;
  answerSource?: AnswerSource;
  sources?: string[];
  backend?: Backend;
  stageTimings?: Record<string, number>;
}
export interface Turn { role: "user" | "assistant"; content: string; createdAt: Date }
export type PendingReason = "not_started" | "image_deferred";
export interface PendingAnswer { id: string; learnerId: number; sessionId: string | null; reason: PendingReason; payload: Record<string, unknown>; createdAt: Date }
export interface KnowledgeChunkInput { position: number; content: string; embedding: number[] }
export interface KnowledgeSourceInput {
  title: string;
  sourceType: "md" | "txt" | "pdf" | "html" | "text";
  origin: "seed" | "add_knowledge";
  addedBy: number | null;
  r2Key: string | null;
  contentHash: string;
}
export interface MemorySession { id: string; learnerId: number; status: "closed_feedback" | "expired"; turns: { role: string; content: string }[] }
export interface MemoryNodeInput { kind: "concept" | "preference" | "difficulty"; label: string; embedding: number[] | null }
export interface MemoryEdgeInput { from: { kind: string; label: string }; relation: string; to: { kind: string; label: string } }
export interface MemoryMatch { id: number; kind: string; label: string; weight: number; similarity: number }
export interface MemoryEdge { fromLabel: string; relation: string; toLabel: string; weight: number }

/** Interface the rest of the Worker depends on (fakes implement it in tests). */
export interface Repository {
  matchChunks(embedding: number[], topK: number, minSimilarity: number): Promise<ChunkMatch[]>;
  upsertLearner(l: { telegramId: number; displayName: string | null; username: string | null; started: boolean }): Promise<Learner>;
  markPrivacyNoticeShown(learnerId: number): Promise<void>;
  openSession(s: { learnerId: number; chatId: number | null; threadId: number | null; messageId: number | null }): Promise<string>;
  getOpenSession(learnerId: number): Promise<OpenSession | null>;
  addTurn(t: TurnInput): Promise<void>;
  getTurns(sessionId: string, limit: number): Promise<Turn[]>;
  closeSessionWithFeedback(sessionId: string, kind: "button" | "reaction" | "text", value: string): Promise<boolean>;
  expireSessions(ttlHours: number): Promise<string[]>;
  addFollowup(sessionId: string, question: string, mentorIds: number[]): Promise<void>;
  countRecentEscalations(learnerId: number, minutes: number): Promise<number>;
  holdAnswer(learnerId: number, sessionId: string | null, reason: PendingReason, payload: Record<string, unknown>): Promise<string>;
  takePendingAnswers(learnerId: number | null, reason: PendingReason, limit: number): Promise<PendingAnswer[]>;
  insertKnowledge(source: KnowledgeSourceInput, chunks: KnowledgeChunkInput[]): Promise<{ sourceId: string | null; chunksAdded: number }>;
  createIngestJob(j: { r2Key: string; fileName: string; sourceType: "pdf" | "html"; requestedBy: number }): Promise<string>;
  heartbeatAgeSeconds(backend: Backend): Promise<number | null>;
  sessionsPendingMemory(limit: number): Promise<MemorySession[]>;
  saveMemory(learnerId: number, sessionId: string, weight: number, nodes: MemoryNodeInput[], edges: MemoryEdgeInput[]): Promise<{ nodes: number; edges: number }>;
  matchMemory(learnerId: number, embedding: number[], k: number): Promise<MemoryMatch[]>;
  memoryEdgesFor(learnerId: number, nodeIds: number[]): Promise<MemoryEdge[]>;
  deleteLearnerData(learnerId: number): Promise<number>;
}

const vec = (v: number[]) => `[${v.join(",")}]`;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const date = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));

export class RpcRepository implements Repository {
  constructor(private readonly rpc: RpcClient) {}

  async matchChunks(embedding: number[], topK: number, minSimilarity: number): Promise<ChunkMatch[]> {
    const rows = await this.rpc.call("match_chunks", { query_embedding: vec(embedding), match_count: topK, min_similarity: minSimilarity });
    return rows.map((r) => ({ id: Number(r.id), sourceId: String(r.source_id), title: String(r.title), content: String(r.content), similarity: Number(r.similarity) }));
  }

  async upsertLearner(l: { telegramId: number; displayName: string | null; username: string | null; started: boolean }): Promise<Learner> {
    const [r] = await this.rpc.call("upsert_learner", { p_telegram_id: l.telegramId, p_display_name: l.displayName, p_username: l.username, p_started: l.started });
    if (!r) throw new RepositoryError("upsert_learner returned no row");
    return { telegramId: Number(r.telegram_id), hasStarted: Boolean(r.has_started), privacyNoticeShown: Boolean(r.privacy_notice_shown), isNew: Boolean(r.is_new) };
  }

  async markPrivacyNoticeShown(learnerId: number): Promise<void> {
    await this.rpc.call("mark_privacy_notice_shown", { p_learner: learnerId });
  }

  async openSession(s: { learnerId: number; chatId: number | null; threadId: number | null; messageId: number | null }): Promise<string> {
    const [r] = await this.rpc.call("open_session", { p_learner: s.learnerId, p_chat: s.chatId, p_thread: s.threadId, p_message: s.messageId });
    if (!r) throw new RepositoryError("open_session returned no row");
    return String(r.id);
  }

  async getOpenSession(learnerId: number): Promise<OpenSession | null> {
    const [r] = await this.rpc.call("get_open_session", { p_learner: learnerId });
    if (!r) return null;
    return { id: String(r.id), originChatId: num(r.origin_chat_id), originThreadId: num(r.origin_thread_id), originMessageId: num(r.origin_message_id), lastActivityAt: date(r.last_activity_at) };
  }

  async addTurn(t: TurnInput): Promise<void> {
    await this.rpc.call("add_turn", {
      p_session: t.sessionId, p_role: t.role, p_content: t.content, p_question_kind: t.questionKind ?? null,
      p_answer_source: t.answerSource ?? null, p_sources: t.sources ?? [], p_backend: t.backend ?? null, p_stage_timings: t.stageTimings ?? {},
    });
  }

  async getTurns(sessionId: string, limit: number): Promise<Turn[]> {
    const rows = await this.rpc.call("get_turns", { p_session: sessionId, p_limit: limit });
    return rows.map((r) => ({ role: r.role as Turn["role"], content: String(r.content), createdAt: date(r.created_at) }));
  }

  async closeSessionWithFeedback(sessionId: string, kind: "button" | "reaction" | "text", value: string): Promise<boolean> {
    const [r] = await this.rpc.call("close_session_feedback", { p_session: sessionId, p_kind: kind, p_value: value });
    return Boolean(r?.closed);
  }

  async expireSessions(ttlHours: number): Promise<string[]> {
    const rows = await this.rpc.call("expire_sessions", { ttl_hours: ttlHours });
    return rows.map((r) => String(r.expire_sessions));
  }

  async addFollowup(sessionId: string, question: string, mentorIds: number[]): Promise<void> {
    await this.rpc.call("add_followup", { p_session: sessionId, p_question: question, p_mentors: mentorIds });
  }

  async countRecentEscalations(learnerId: number, minutes: number): Promise<number> {
    const [r] = await this.rpc.call("count_recent_escalations", { p_learner: learnerId, p_minutes: minutes });
    return Number(r?.n ?? 0);
  }

  async holdAnswer(learnerId: number, sessionId: string | null, reason: PendingReason, payload: Record<string, unknown>): Promise<string> {
    const [r] = await this.rpc.call("hold_answer", { p_learner: learnerId, p_session: sessionId, p_reason: reason, p_payload: payload });
    if (!r) throw new RepositoryError("hold_answer returned no row");
    return String(r.id);
  }

  async takePendingAnswers(learnerId: number | null, reason: PendingReason, limit: number): Promise<PendingAnswer[]> {
    const rows = await this.rpc.call("take_pending_answers", { p_learner: learnerId, p_reason: reason, p_limit: limit });
    return rows.map((r) => ({
      id: String(r.id), learnerId: Number(r.learner_id), sessionId: r.session_id ? String(r.session_id) : null,
      reason: r.reason as PendingReason, payload: (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as Record<string, unknown>,
      createdAt: date(r.created_at),
    }));
  }

  async insertKnowledge(source: KnowledgeSourceInput, chunks: KnowledgeChunkInput[]): Promise<{ sourceId: string | null; chunksAdded: number }> {
    const [r] = await this.rpc.call("insert_knowledge", {
      p_title: source.title, p_source_type: source.sourceType, p_origin: source.origin, p_added_by: source.addedBy,
      p_r2_key: source.r2Key, p_content_hash: source.contentHash, p_chunks: chunks,
    });
    return { sourceId: r?.source_id ? String(r.source_id) : null, chunksAdded: Number(r?.chunks_added ?? 0) };
  }

  async createIngestJob(j: { r2Key: string; fileName: string; sourceType: "pdf" | "html"; requestedBy: number }): Promise<string> {
    const [r] = await this.rpc.call("create_ingest_job", { p_r2_key: j.r2Key, p_file_name: j.fileName, p_source_type: j.sourceType, p_requested_by: j.requestedBy });
    if (!r) throw new RepositoryError("create_ingest_job returned no row");
    return String(r.id);
  }

  async heartbeatAgeSeconds(backend: Backend): Promise<number | null> {
    const [r] = await this.rpc.call("latest_heartbeat", { p_backend: backend });
    return r ? Number(r.age_seconds) : null;
  }

  async sessionsPendingMemory(limit: number): Promise<MemorySession[]> {
    const rows = await this.rpc.call("sessions_pending_memory", { p_limit: limit });
    return rows.map((r) => ({
      id: String(r.id), learnerId: Number(r.learner_id), status: r.status as MemorySession["status"],
      turns: (typeof r.turns === "string" ? JSON.parse(r.turns) : r.turns) as MemorySession["turns"],
    }));
  }

  async saveMemory(learnerId: number, sessionId: string, weight: number, nodes: MemoryNodeInput[], edges: MemoryEdgeInput[]): Promise<{ nodes: number; edges: number }> {
    const [r] = await this.rpc.call("save_memory", { p_learner: learnerId, p_session: sessionId, p_weight: weight, p_nodes: nodes, p_edges: edges });
    return { nodes: Number(r?.nodes ?? 0), edges: Number(r?.edges ?? 0) };
  }

  async matchMemory(learnerId: number, embedding: number[], k: number): Promise<MemoryMatch[]> {
    const rows = await this.rpc.call("match_memory_nodes", { p_learner: learnerId, query_embedding: vec(embedding), match_count: k });
    return rows.map((r) => ({ id: Number(r.id), kind: String(r.kind), label: String(r.label), weight: Number(r.weight), similarity: Number(r.similarity) }));
  }

  async memoryEdgesFor(learnerId: number, nodeIds: number[]): Promise<MemoryEdge[]> {
    if (nodeIds.length === 0) return [];
    const rows = await this.rpc.call("memory_edges_for", { p_learner: learnerId, p_node_ids: nodeIds });
    return rows.map((r) => ({ fromLabel: String(r.from_label), relation: String(r.relation), toLabel: String(r.to_label), weight: Number(r.weight) }));
  }

  async deleteLearnerData(learnerId: number): Promise<number> {
    const [r] = await this.rpc.call("delete_learner_data", { p_learner: learnerId });
    return Number(r?.delete_learner_data ?? 0);
  }
}
