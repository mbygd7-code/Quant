/**
 * CLAUDE.md §3-A forbidden-word guard for user-facing narratives.
 *
 * TS mirror of `agents/llm/sanitize.py`. Keep the lists in sync — both
 * paths apply this gate at agent-output time so any divergence makes
 * the same prompt produce different validation behaviour on Python
 * and TS.
 */

/** Words that must never appear in a user-facing narrative. */
export const FORBIDDEN_WORDS: readonly string[] = [
  '매수',
  '매도',
  '강력 추천',
  '오늘 오른다',
  '오늘 내린다',
  '확정',
  '보장',
  '100%',
];

/**
 * Descriptive market/technical compounds that contain '매수'/'매도' as a
 * substring but are NOT trade recommendations. A naive substring scan
 * false-positives on these — most damagingly '과매수'/'과매도', which the
 * technical voter is told to use. Standalone '매수'/'매도' and every
 * recommendation phrasing ('매수하세요', '매수 추천', '지금 매수') still trip
 * the guard. Keep in sync with agents/llm/sanitize.py ALLOWED_COMPOUNDS.
 */
export const ALLOWED_COMPOUNDS: readonly string[] = [
  '과매수', '과매도',
  '순매수', '순매도',
  '매수세', '매도세',
  '매수잔량', '매도잔량',
  '매수호가', '매도호가',
  '매수주체', '매도주체',
  '매수우위', '매도우위',
];

/** True when the banned `word` at `pos` is part of a legitimate compound. */
function isAllowedCompound(narrative: string, word: string, pos: number): boolean {
  for (const compound of ALLOWED_COMPOUNDS) {
    const off = compound.indexOf(word);
    if (off < 0) continue;
    const start = pos - off;
    if (start >= 0 && narrative.slice(start, start + compound.length) === compound) {
      return true;
    }
  }
  return false;
}

export class ForbiddenWordError extends Error {
  constructor(
    public readonly word: string,
    public readonly position: number,
    public readonly narrative: string,
  ) {
    super(`forbidden word ${JSON.stringify(word)} at position ${position}`);
    this.name = 'ForbiddenWordError';
  }
}

/** Returns every `[word, position]` violation. Empty list = clean. */
export function forbiddenWordsViolations(
  narrative: string,
): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const word of FORBIDDEN_WORDS) {
    let idx = 0;
    while (true) {
      const found = narrative.indexOf(word, idx);
      if (found < 0) break;
      if (!isAllowedCompound(narrative, word, found)) {
        out.push([word, found]);
      }
      idx = found + word.length;
    }
  }
  return out;
}

/**
 * Returns the input unchanged if clean; throws `ForbiddenWordError`
 * otherwise. Never scrubs — the right move on a violation is to retry
 * the LLM call, not to silently rewrite output.
 */
export function sanitizeNarrative(narrative: string): string {
  const violations = forbiddenWordsViolations(narrative);
  if (violations.length > 0) {
    const [word, pos] = violations[0];
    throw new ForbiddenWordError(word, pos, narrative);
  }
  return narrative;
}
