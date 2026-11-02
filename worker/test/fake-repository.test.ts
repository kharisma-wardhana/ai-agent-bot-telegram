import { describe, expect, it } from "vitest";
import { FakeRepository } from "./fakes/fake-repository";

// Guards the fake against drifting from the SQL semantics proven in test/db/repository.test.ts.
describe("FakeRepository mirrors key SQL semantics", () => {
  it("dedupes knowledge by hash, closes sessions once, hands held answers out once, deletes per learner", async () => {
    const r = new FakeRepository();
    const src = { title: "t", sourceType: "md" as const, origin: "seed" as const, addedBy: null, r2Key: null, contentHash: "h" };
    expect((await r.insertKnowledge(src, [{ position: 0, content: "c", embedding: [1, 0] }])).chunksAdded).toBe(1);
    expect(await r.insertKnowledge(src, [])).toEqual({ sourceId: null, chunksAdded: 0 });

    await r.upsertLearner({ telegramId: 1, displayName: "A", username: null, started: true });
    await r.upsertLearner({ telegramId: 2, displayName: "B", username: null, started: true });
    const s1 = await r.openSession({ learnerId: 1, chatId: null, threadId: null, messageId: null });
    await r.openSession({ learnerId: 2, chatId: null, threadId: null, messageId: null });
    expect(await r.closeSessionWithFeedback(s1, "button", "up")).toBe(true);
    expect(await r.closeSessionWithFeedback(s1, "button", "up")).toBe(false);

    await r.holdAnswer(1, null, "not_started", { a: 1 });
    expect(await r.takePendingAnswers(1, "not_started", 5)).toHaveLength(1);
    expect(await r.takePendingAnswers(1, "not_started", 5)).toHaveLength(0);

    expect(await r.deleteLearnerData(1)).toBe(1);
    expect(r.sessions.map((s) => s.learnerId)).toEqual([2]);
  });
});
