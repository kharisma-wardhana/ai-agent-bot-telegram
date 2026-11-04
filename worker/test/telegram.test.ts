import { describe, expect, it } from "vitest";
import { TelegramClient, TelegramError } from "../src/telegram/client";
import { classify } from "../src/telegram/parse-update";
import { ProgressMessage, STAGES } from "../src/telegram/progress";
import { BOT, callback, dm, FakeTelegram, GROUP_ID, groupAsk, learner, reaction } from "./fakes/fake-telegram";

const cfg = { groupChatId: GROUP_ID, botUsername: BOT };

describe("classify (AC 1)", () => {
  it("ignores group messages without #askAI and messages from other groups or bots", () => {
    expect(classify(groupAsk("halo semua"), cfg)).toMatchObject({ kind: "ignore", reason: "no #askAI" });
    expect(classify(groupAsk("#askAI apa itu RAG", { chatId: -999 }), cfg)).toMatchObject({ kind: "ignore", reason: "other group" });
    expect(classify(groupAsk("#askAI hi", { from: { ...learner(), is_bot: true } as never }), cfg)).toMatchObject({ kind: "ignore" });
  });

  it("parses #askAI text, photo and voice questions with topic and hashtag stripped", () => {
    const t = classify(groupAsk("Apa itu RAG? #askAI", { thread: 77 }), cfg);
    expect(t).toMatchObject({ kind: "ask", question: "Apa itu RAG?", threadId: 77, chatId: GROUP_ID, media: null });
    const p = classify(groupAsk("#AskAI ini diagram apa?", { photo: true }), cfg);
    expect(p).toMatchObject({ kind: "ask", question: "ini diagram apa?", media: { type: "photo", fileId: "ph_big" } });
    const v = classify(groupAsk("#askAI", { voice: true }), cfg);
    expect(v).toMatchObject({ kind: "ask", question: "", media: { type: "voice", fileId: "vc1", mime: "audio/ogg" } });
  });

  it("parses DM commands, including @bot suffixes and the hyphen-free command names", () => {
    expect(classify(dm("/start q_abc"), cfg)).toMatchObject({ kind: "start", payload: "q_abc" });
    expect(classify(dm("/start"), cfg)).toMatchObject({ kind: "start", payload: null });
    expect(classify(dm(`/add_knowledge@${BOT} Materi baru`), cfg)).toMatchObject({ kind: "add_knowledge", text: "Materi baru", document: null });
    expect(classify(dm("/addknowledge", { document: { file_id: "d1", file_name: "a.pdf", mime_type: "application/pdf" } }), cfg))
      .toMatchObject({ kind: "add_knowledge", text: null, document: { fileId: "d1", fileName: "a.pdf", mime: "application/pdf" } });
    expect(classify(dm("/hapusdata"), cfg)).toMatchObject({ kind: "hapusdata" });
    expect(classify(dm("/add_knowledge@other_bot x"), cfg)).toMatchObject({ kind: "ignore" });
  });

  it("parses feedback buttons, feedback reactions and DM text (with reply target)", () => {
    expect(classify(callback("fb:up"), cfg)).toMatchObject({ kind: "feedback", via: "button", value: "up" });
    expect(classify(callback("evil"), cfg)).toMatchObject({ kind: "ignore" });
    expect(classify(reaction("👍"), cfg)).toMatchObject({ kind: "feedback", via: "reaction", value: "👍" });
    expect(classify(reaction("🔥"), cfg)).toMatchObject({ kind: "ignore" });
    expect(classify(dm("makasih kak", { replyTo: 1234 }), cfg)).toMatchObject({ kind: "dm_text", text: "makasih kak", replyToMessageId: 1234 });
    expect(classify(dm("jelaskan lebih sederhana"), cfg)).toMatchObject({ kind: "dm_text", replyToMessageId: null });
  });
});

describe("TelegramClient", () => {
  it("surfaces 403 as cannotDm and never puts the token in errors", async () => {
    const tg = new FakeTelegram();
    tg.notStarted.add(501);
    const client = new TelegramClient("123:SECRET", tg.fetch);
    const err = await client.sendMessage(501, "hai").catch((e) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.cannotDm).toBe(true);
    expect(err.message).not.toContain("SECRET");
  });

  it("sends plain text with reply and thread parameters", async () => {
    const tg = new FakeTelegram();
    await new TelegramClient("t", tg.fetch).sendMessage(GROUP_ID, "x", { threadId: 42, replyTo: 7 });
    expect(tg.calls[0]!.params).toMatchObject({ chat_id: GROUP_ID, message_thread_id: 42, reply_parameters: { message_id: 7 } });
    expect(tg.calls[0]!.params.parse_mode).toBeUndefined();
  });
});

describe("ProgressMessage (AC 3)", () => {
  it("shows stages in order, throttles stream edits to 1/s and caps the preview", async () => {
    const tg = new FakeTelegram();
    let t = 0;
    const p = new ProgressMessage(new TelegramClient("t", tg.fetch), 501, 50, () => t);
    await p.start();
    await p.stage("searching");
    await p.stage("composing");
    for (let i = 0; i < 10; i++) { t += 200; await p.stream("abcdefghij"); }
    await p.finish("Jawaban final");
    const texts = tg.textsIn(501);
    expect(texts[0]).toBe(STAGES.received);
    expect(texts[1]).toBe(`${STAGES.received}\n${STAGES.searching}`);
    expect(texts[2]).toContain(STAGES.composing);
    const streamEdits = texts.slice(3, -1);
    expect(streamEdits.length).toBe(2); // 2000ms of fragments at ≥1000ms spacing
    expect(Math.max(...streamEdits.map((s) => s.split("\n\n")[1]!.length))).toBeLessThanOrEqual(50);
    expect(texts.at(-1)).toBe("Jawaban final");
    expect(p.timings.searching).toBe(0);
  });
});
