import type {
  Backend, ChunkMatch, KnowledgeChunkInput, KnowledgeSourceInput, Learner, MemoryEdge, MemoryEdgeInput, MemoryMatch,
  MemoryNodeInput, MemorySession, OpenSession, PendingAnswer, PendingReason, Repository, Turn, TurnInput,
} from "../../src/db/repository";

const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};

interface SessionRec { id: string; learnerId: number; chatId: number | null; threadId: number | null; messageId: number | null; status: "open" | "closed_feedback" | "expired"; memory: "pending" | "done"; lastActivityAt: Date }

/** In-memory Repository for Worker integration tests (Miniflare can't host PGlite). Mirrors the SQL semantics. */
export class FakeRepository implements Repository {
  sources: (KnowledgeSourceInput & { id: string })[] = [];
  chunks: { sourceId: string; title: string; content: string; embedding: number[] }[] = [];
  learners = new Map<number, Learner & { displayName: string | null }>();
  sessions: SessionRec[] = [];
  turns: (TurnInput & { createdAt: Date })[] = [];
  feedback: { sessionId: string; kind: string; value: string }[] = [];
  followups: { sessionId: string; question: string; mentorIds: number[]; at: Date }[] = [];
  pending: (PendingAnswer & { delivered: boolean })[] = [];
  ingestJobs: { id: string; r2Key: string; fileName: string; sourceType: string; requestedBy: number }[] = [];
  heartbeatAge: number | null = null;
  memoryNodes: { id: number; learnerId: number; kind: string; label: string; embedding: number[] | null; weight: number }[] = [];
  memoryEdges: { learnerId: number; from: number; relation: string; to: number; weight: number }[] = [];
  private seq = 0;
  private uid = () => `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`;

  async matchChunks(embedding: number[], topK: number, minSimilarity: number): Promise<ChunkMatch[]> {
    return this.chunks
      .map((c, i) => ({ id: i + 1, sourceId: c.sourceId, title: c.title, content: c.content, similarity: cos(c.embedding, embedding) }))
      .filter((c) => c.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  async upsertLearner(l: { telegramId: number; displayName: string | null; username: string | null; started: boolean }): Promise<Learner> {
    const cur = this.learners.get(l.telegramId);
    if (!cur) {
      const rec = { telegramId: l.telegramId, displayName: l.displayName, hasStarted: l.started, privacyNoticeShown: false, isNew: true };
      this.learners.set(l.telegramId, rec);
      return { ...rec };
    }
    cur.hasStarted = cur.hasStarted || l.started;
    cur.displayName = l.displayName ?? cur.displayName;
    cur.isNew = false;
    return { telegramId: cur.telegramId, hasStarted: cur.hasStarted, privacyNoticeShown: cur.privacyNoticeShown, isNew: false };
  }

  async markPrivacyNoticeShown(learnerId: number) {
    const l = this.learners.get(learnerId);
    if (l) l.privacyNoticeShown = true;
  }

  async openSession(s: { learnerId: number; chatId: number | null; threadId: number | null; messageId: number | null }) {
    const id = this.uid();
    this.sessions.push({ id, ...s, status: "open", memory: "pending", lastActivityAt: new Date() });
    return id;
  }

  async getOpenSession(learnerId: number): Promise<OpenSession | null> {
    const s = this.sessions.filter((x) => x.learnerId === learnerId && x.status === "open").at(-1);
    return s ? { id: s.id, originChatId: s.chatId, originThreadId: s.threadId, originMessageId: s.messageId, lastActivityAt: s.lastActivityAt } : null;
  }

  async addTurn(t: TurnInput) {
    this.turns.push({ ...t, createdAt: new Date() });
    const s = this.sessions.find((x) => x.id === t.sessionId);
    if (s) s.lastActivityAt = new Date();
  }

  async getTurns(sessionId: string, limit: number): Promise<Turn[]> {
    return this.turns.filter((t) => t.sessionId === sessionId).slice(-limit).map((t) => ({ role: t.role, content: t.content, createdAt: t.createdAt }));
  }

  async closeSessionWithFeedback(sessionId: string, kind: "button" | "reaction" | "text", value: string) {
    this.feedback.push({ sessionId, kind, value });
    const s = this.sessions.find((x) => x.id === sessionId);
    if (s && s.status === "open") { s.status = "closed_feedback"; return true; }
    return false;
  }

  async expireSessions(ttlHours: number) {
    const cutoff = Date.now() - ttlHours * 3600_000;
    const out: string[] = [];
    for (const s of this.sessions) if (s.status === "open" && s.lastActivityAt.getTime() < cutoff) { s.status = "expired"; out.push(s.id); }
    return out;
  }

  async addFollowup(sessionId: string, question: string, mentorIds: number[]) {
    this.followups.push({ sessionId, question, mentorIds, at: new Date() });
  }

  async countRecentEscalations(learnerId: number, minutes: number) {
    const cutoff = Date.now() - minutes * 60_000;
    return this.followups.filter((f) => f.at.getTime() > cutoff && this.sessions.find((s) => s.id === f.sessionId)?.learnerId === learnerId).length;
  }

  async holdAnswer(learnerId: number, sessionId: string | null, reason: PendingReason, payload: Record<string, unknown>) {
    const id = this.uid();
    this.pending.push({ id, learnerId, sessionId, reason, payload, createdAt: new Date(), delivered: false });
    return id;
  }

  async takePendingAnswers(learnerId: number | null, reason: PendingReason, limit: number): Promise<PendingAnswer[]> {
    const got = this.pending.filter((p) => !p.delivered && p.reason === reason && (learnerId === null || p.learnerId === learnerId)).slice(0, limit);
    for (const p of got) p.delivered = true;
    return got.map(({ delivered: _d, ...p }) => p);
  }

  async insertKnowledge(source: KnowledgeSourceInput, chunks: KnowledgeChunkInput[]) {
    if (this.sources.some((s) => s.contentHash === source.contentHash)) return { sourceId: null, chunksAdded: 0 };
    const id = this.uid();
    this.sources.push({ ...source, id });
    for (const c of chunks) this.chunks.push({ sourceId: id, title: source.title, content: c.content, embedding: c.embedding });
    return { sourceId: id, chunksAdded: chunks.length };
  }

  async createIngestJob(j: { r2Key: string; fileName: string; sourceType: "pdf" | "html"; requestedBy: number }) {
    const id = this.uid();
    this.ingestJobs.push({ id, ...j });
    return id;
  }

  async heartbeatAgeSeconds(_backend: Backend) {
    return this.heartbeatAge;
  }

  async sessionsPendingMemory(limit: number): Promise<MemorySession[]> {
    return this.sessions
      .filter((s) => s.status !== "open" && s.memory === "pending")
      .slice(0, limit)
      .map((s) => ({ id: s.id, learnerId: s.learnerId, status: s.status as MemorySession["status"], turns: this.turns.filter((t) => t.sessionId === s.id).map((t) => ({ role: t.role, content: t.content })) }));
  }

  async saveMemory(learnerId: number, sessionId: string, weight: number, nodes: MemoryNodeInput[], edges: MemoryEdgeInput[]) {
    for (const n of nodes) {
      const cur = this.memoryNodes.find((m) => m.learnerId === learnerId && m.kind === n.kind && m.label === n.label);
      if (cur) { cur.weight += weight; cur.embedding = n.embedding ?? cur.embedding; }
      else this.memoryNodes.push({ id: ++this.seq, learnerId, kind: n.kind, label: n.label, embedding: n.embedding, weight });
    }
    let ne = 0;
    for (const e of edges) {
      const f = this.memoryNodes.find((m) => m.learnerId === learnerId && m.kind === e.from.kind && m.label === e.from.label);
      const t = this.memoryNodes.find((m) => m.learnerId === learnerId && m.kind === e.to.kind && m.label === e.to.label);
      if (f && t) { this.memoryEdges.push({ learnerId, from: f.id, relation: e.relation, to: t.id, weight }); ne++; }
    }
    const s = this.sessions.find((x) => x.id === sessionId);
    if (s) s.memory = "done";
    return { nodes: nodes.length, edges: ne };
  }

  async matchMemory(learnerId: number, embedding: number[], k: number): Promise<MemoryMatch[]> {
    return this.memoryNodes
      .filter((n) => n.learnerId === learnerId && n.embedding)
      .map((n) => ({ id: n.id, kind: n.kind, label: n.label, weight: n.weight, similarity: cos(n.embedding!, embedding) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }

  async memoryEdgesFor(learnerId: number, nodeIds: number[]): Promise<MemoryEdge[]> {
    const label = (id: number) => this.memoryNodes.find((n) => n.id === id)?.label ?? "";
    return this.memoryEdges
      .filter((e) => e.learnerId === learnerId && (nodeIds.includes(e.from) || nodeIds.includes(e.to)))
      .map((e) => ({ fromLabel: label(e.from), relation: e.relation, toLabel: label(e.to), weight: e.weight }));
  }

  async deleteLearnerData(learnerId: number) {
    const ids = new Set(this.sessions.filter((s) => s.learnerId === learnerId).map((s) => s.id));
    this.sessions = this.sessions.filter((s) => s.learnerId !== learnerId);
    this.turns = this.turns.filter((t) => !ids.has(t.sessionId));
    this.feedback = this.feedback.filter((f) => !ids.has(f.sessionId));
    this.followups = this.followups.filter((f) => !ids.has(f.sessionId));
    this.pending = this.pending.filter((p) => p.learnerId !== learnerId);
    this.memoryNodes = this.memoryNodes.filter((n) => n.learnerId !== learnerId);
    this.memoryEdges = this.memoryEdges.filter((e) => e.learnerId !== learnerId);
    this.learners.delete(learnerId);
    return ids.size;
  }
}
