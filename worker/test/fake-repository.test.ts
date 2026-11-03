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

describe("FakeRepository mirrors the 0004 dashboard semantics (step 2)", () => {
  it("one claim wins, lapsed claims reopen, close happens once, knowledge links once, removal revokes sessions", async () => {
    const r = new FakeRepository();
    await r.upsertLearner({ telegramId: 7, displayName: "Ani", username: null, started: true });
    const s = await r.openSession({ learnerId: 7, chatId: -100, threadId: 3, messageId: 9 });
    const id = await r.addFollowupV2(s, "q", [1], null);
    expect((await r.claimFollowup(id, "a", "A", 60)).claimed).toBe(true);
    expect(await r.claimFollowup(id, "b", "B", 60)).toEqual({ claimed: false, claimedByName: "A" });
    r.followups[0]!.claimedAt = new Date(Date.now() - 61_000);
    expect((await r.listFollowups("active", 60))[0]!.status).toBe("open");
    expect(await r.closeFollowup(id, "a", "A", "x", 60)).toBeNull();
    expect((await r.claimFollowup(id, "b", "B", 60)).claimed).toBe(true);
    expect(await r.closeFollowup(id, "b", "B", "jawab", 60)).toMatchObject({ learnerId: 7, learnerName: "Ani", originThreadId: 3 });
    expect(await r.closeFollowup(id, "b", "B", "jawab", 60)).toBeNull();
    expect(await r.setFollowupKnowledge(id, "src")).toBe(true);
    expect(await r.setFollowupKnowledge(id, "src")).toBe(false);

    const uid = await r.addDashboardUser({ email: "M@x", displayName: "M", telegramId: 5, addedByEmail: "o" });
    await r.createDashboardSession("h", "c", "m@x", 60);
    await r.removeDashboardUser(uid!);
    expect(await r.getDashboardSession("h")).toBeNull();
  });
});

describe("FakeRepository mirrors the 0005 welcome semantics (step 2)", () => {
  it("queues idempotently, unqueues, takes each row once oldest first, and enforces the template checks", async () => {
    const r = new FakeRepository();
    await r.queueWelcome(1, "Ani");
    await r.queueWelcome(1, "Ani B");
    await r.queueWelcome(2, "Budi");
    r.pendingWelcomes.find((p) => p.telegramId === 2)!.joinedAt = new Date(Date.now() - 60_000);
    expect((await r.takePendingWelcomes(1)).map((p) => p.telegramId)).toEqual([2]);
    expect(await r.unqueueWelcome(1)).toBe(true);
    expect(await r.takePendingWelcomes(5)).toEqual([]);
    await expect(r.saveWelcomeSettings({ template: "tanpa placeholder", topicId: null, welcomeEnabled: true, leaveEnabled: true, updatedBy: "a" })).rejects.toThrow();
    expect(await r.getWelcomeSettings()).toBeNull();
  });
});
