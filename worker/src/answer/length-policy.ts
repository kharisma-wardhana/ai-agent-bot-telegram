/**
 * 1000-character policy (spec › Architecture): prompt budget → one compression pass → hard cut at
 * the last sentence boundary. composeFinal guarantees the learner never receives more than `max`.
 */

export const COMPRESS_TARGET = 900;
const ELLIPSIS = "…";

/** Cuts to ≤ max at the last sentence end; falls back to the last space + ellipsis. */
export function cutAtSentence(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const window = t.slice(0, max);
  let end = -1;
  const re = /[.!?…](?=\s|$)/g;
  for (let m = re.exec(window); m; m = re.exec(window)) end = m.index + 1;
  if (end >= max * 0.5) return window.slice(0, end).trim();
  const room = window.slice(0, max - ELLIPSIS.length);
  const sp = room.lastIndexOf(" ");
  return (sp > 0 ? room.slice(0, sp) : room).trimEnd() + ELLIPSIS;
}

export type Compressor = (text: string, targetChars: number) => Promise<string>;

/** Ensures body ≤ max, using one compression pass when available, then a hard cut. */
export async function enforceLength(body: string, max: number, compress?: Compressor): Promise<{ text: string; compressed: boolean; cut: boolean }> {
  const t = body.trim();
  if (t.length <= max) return { text: t, compressed: false, cut: false };
  let candidate = t;
  let compressed = false;
  if (compress) {
    try {
      const c = (await compress(t, Math.min(COMPRESS_TARGET, max))).trim();
      // Re-check: an empty or NOT_FOUND "summary" is discarded in favour of the hard cut.
      if (c && !/NOT_FOUND/i.test(c)) {
        candidate = c;
        compressed = true;
      }
    } catch {
      /* compression failed: fall through to the hard cut */
    }
  }
  if (candidate.length <= max) return { text: candidate, compressed, cut: false };
  return { text: cutAtSentence(candidate, max), compressed, cut: true };
}

/** Body + source line, total ≤ max. The source line is kept; the body absorbs the cut. */
export async function composeFinal(body: string, sourceLine: string, max: number, compress?: Compressor): Promise<string> {
  const suffix = sourceLine ? `\n\n${sourceLine}` : "";
  const safeSuffix = suffix.length > max / 3 ? cutAtSentence(suffix, Math.floor(max / 3)) : suffix;
  const budget = max - safeSuffix.length;
  const { text } = await enforceLength(body, budget, compress);
  const out = text + safeSuffix;
  return out.length <= max ? out : cutAtSentence(out, max); // belt and braces
}
