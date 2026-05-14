/**
 * Shared KR-ticker validation.
 *
 * Older Korean equities use a 6-digit numeric code (e.g. 005930 = Samsung
 * Electronics). Newer ETFs ship with 6-character alphanumeric codes that
 * include a letter (e.g. 0167A0 = SOL AI반도체TOP2플러스).
 *
 * Centralised here so every API route / component validates consistently.
 * Pre-2026 sites had `^\d{6}$` scattered across 5+ files and would
 * silently reject ETFs — see audit High #4.
 */

/** Match a 6-char alphanumeric Korean ticker (uppercase). */
export const KR_TICKER_RE = /^[0-9A-Z]{6}$/;

/** Normalize + test a candidate string. */
export function isKrTicker(s: string): boolean {
  return KR_TICKER_RE.test(s.toUpperCase());
}

/** Returns the uppercase-normalized ticker if valid, else null. */
export function parseKrTicker(s: string): string | null {
  const u = s.trim().toUpperCase();
  return KR_TICKER_RE.test(u) ? u : null;
}
