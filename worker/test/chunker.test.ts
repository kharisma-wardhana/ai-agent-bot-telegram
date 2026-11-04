import { describe, expect, it } from "vitest";
import fixture from "../../ingest/tests/fixtures/chunk_case.json";
import { CHUNK_SIZE, chunk, contentHash, normalize } from "../src/rag/chunker";

describe("chunker parity with ingest/src/ingest/chunker.py", () => {
  it("produces exactly the Python chunks and hash for the shared fixture", async () => {
    expect(chunk(fixture.input, fixture.size, fixture.overlap)).toEqual(fixture.expected);
    expect(await contentHash(fixture.input)).toBe(fixture.hash);
  });

  it("normalises whitespace like the Python version", () => {
    expect(normalize("  a \t b \r\n\r\n\r\n\n c  ")).toBe("a b\n\nc");
  });

  it("keeps every chunk within size, including hard-split sentences", () => {
    for (const c of chunk("x".repeat(2000))) expect(c.length).toBeLessThanOrEqual(CHUNK_SIZE);
    expect(chunk(" \n\n ")).toEqual([]);
  });
});
