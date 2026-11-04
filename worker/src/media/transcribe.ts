import type { AiBinding } from "../llm/types";

export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

export interface Transcriber {
  transcribe(audio: ArrayBuffer, mime: string): Promise<string>;
}

export function toBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Whisper on Workers AI. Audio bytes are sent once and never stored (AC 10). */
export class WorkersAiTranscriber implements Transcriber {
  constructor(private readonly ai: AiBinding) {}

  async transcribe(audio: ArrayBuffer, _mime: string): Promise<string> {
    const out = (await this.ai.run(WHISPER_MODEL, { audio: toBase64(audio), language: "id", task: "transcribe" })) as { text?: string };
    return (out.text ?? "").trim();
  }
}
