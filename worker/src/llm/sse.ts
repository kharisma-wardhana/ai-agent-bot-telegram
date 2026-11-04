import type { ToolCall } from "./types";

/** Iterates `data:` payloads of a Server-Sent Events stream, stopping at `[DONE]`. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      if (data) yield data;
    }
    if (done) {
      const tail = buf.trim();
      if (tail.startsWith("data:") && tail.slice(5).trim() !== "[DONE]") yield tail.slice(5).trim();
      return;
    }
  }
}

interface DeltaToolCall { index?: number; id?: string; function?: { name?: string; arguments?: string } }

/** Assembles OpenAI-style streamed tool-call fragments (keyed by index) into whole calls. */
export class ToolCallAssembler {
  private parts = new Map<number, { id: string; name: string; arguments: string }>();

  push(deltas: DeltaToolCall[] | undefined) {
    for (const d of deltas ?? []) {
      const i = d.index ?? 0;
      const cur = this.parts.get(i) ?? { id: "", name: "", arguments: "" };
      if (d.id) cur.id = d.id;
      if (d.function?.name) cur.name += d.function.name;
      if (d.function?.arguments) cur.arguments += d.function.arguments;
      this.parts.set(i, cur);
    }
  }

  calls(): ToolCall[] {
    return [...this.parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments || "{}" }));
  }
}
