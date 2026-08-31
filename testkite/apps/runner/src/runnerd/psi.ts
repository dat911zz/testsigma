/**
 * PSI (Pressure Stall Information) is the host watermark input (docs/SYSTEM_DESIGN.md §5):
 * GREEN/AMBER/RED tells the control plane whether this host should keep receiving work.
 *
 * It reads a number the kernel already computes — the share of wall time SOMETHING was stalled
 * on memory — which is a far better signal than free bytes: a host can look "free" while every
 * process on it thrashes on reclaim, because the page cache is counted as available right up to
 * the moment it is being refaulted in a loop.
 *
 * WHAT IS PROVEN WHERE. The dev sandbox has no `/proc/pressure` at all (spike 2026-08-29), so
 * `test/runnerd/psi.test.ts` drives the parser with the kernel's documented TEXT and proves the
 * format is read correctly; that a real kernel's file parses is `test/host/psi.test.ts`, gated
 * behind `test:host`. A missing file therefore reads as "unknown", and an unknown is GREEN:
 * treating it as RED would drain a whole fleet the first time it booted on a kernel built
 * without CONFIG_PSI.
 */
import { readFileSync } from "node:fs";

export interface PsiSample {
  /** Share of the last 10s in which SOME task was stalled on memory. The fast signal. */
  readonly some10: number;
  /** The same over 60s — slower, and what tells a spike apart from a trend in a log line. */
  readonly some60: number;
  /** Share of the last 10s in which EVERY task was stalled. Anything above zero is already bad. */
  readonly full10: number;
}

/** Above this share of stalled wall time the host is warm: still working, no longer comfortable. */
export const PSI_AMBER_PCT = 10;
/** Above this the host is thrashing, and sending it another chain makes the queue slower, not faster. */
export const PSI_RED_PCT = 30;

export type Watermark = "green" | "amber" | "red";

/** `avg10=42.31` — the kernel writes fixed-point percentages, never exponents or signs. */
const SOME_LINE = /^some\s+avg10=([\d.]+)\s+avg60=([\d.]+)/mu;
const FULL_LINE = /^full\s+avg10=([\d.]+)/mu;

function averageOf(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parses the two lines of `/proc/pressure/memory`. Returns null — never a zeroed sample — for
 * anything else: a zero would read downstream as "this host is perfectly calm", which is the one
 * lie that matters here.
 */
export function parsePsi(text: string): PsiSample | null {
  const some = SOME_LINE.exec(text);
  const full = FULL_LINE.exec(text);
  if (some === null || full === null) return null;
  const some10 = averageOf(some[1]);
  const some60 = averageOf(some[2]);
  const full10 = averageOf(full[1]);
  if (some10 === null || some60 === null || full10 === null) return null;
  return { some10, some60, full10 };
}

export function readPsi(path = "/proc/pressure/memory"): PsiSample | null {
  try {
    return parsePsi(readFileSync(path, "utf8"));
  } catch {
    return null; // this kernel does not expose PSI
  }
}

/**
 * `some10` is the axis on purpose: `full10` above zero means the host is already unusable, so a
 * watermark that waited for it would only ever report an emergency after the fact.
 */
export function watermarkFor(sample: PsiSample | null): Watermark {
  if (sample === null) return "green";
  if (sample.some10 >= PSI_RED_PCT) return "red";
  if (sample.some10 >= PSI_AMBER_PCT) return "amber";
  return "green";
}
