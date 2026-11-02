import { sseData, ToolCallAssembler } from "./sse";
import { LlmError, type ChatRequest, type ChatResult, type LlmBackend, type OnDelta } from "./types";

export const KAGGLE_MODEL = "qwen3-vl-8b";
export const KAGGLE_SECRET_HEADER = "X-Skilly-Secret";

/** OpenAI-compatible vLLM server on Kaggle, reached through a Cloudflare Tunnel behind a shared secret. */
export class KaggleBackend implements LlmBackend {
  readonly name = "kaggle" as const;
  readonly supportsImages = true;

  constructor(
    private readonly baseUrl: string,
    private readonly sharedSecret: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 45_000,
  ) {}

  async chat(req: ChatRequest, onDelta?: OnDelta): Promise<ChatResult> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [KAGGLE_SECRET_HEADER]: this.sharedSecret },
        body: JSON.stringify({
          model: KAGGLE_MODEL,
          messages: req.messages,
          tools: req.tools && req.tools.length ? req.tools : undefined,
          max_tokens: req.maxTokens ?? 600,
          temperature: req.temperature ?? 0.3,
          stream: true,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new LlmError(`kaggle unreachable: ${(e as Error).message}`, "kaggle");
    }
    if (!res.ok || !res.body) throw new LlmError(`kaggle HTTP ${res.status}`, "kaggle");

    let content = "";
    const tools = new ToolCallAssembler();
    for await (const data of sseData(res.body)) {
      let chunk: { choices?: { delta?: { content?: string; tool_calls?: [] } }[] };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        await onDelta?.(delta.content);
      }
      tools.push(delta.tool_calls);
    }
    return { content, toolCalls: tools.calls(), backend: "kaggle" };
  }
}
