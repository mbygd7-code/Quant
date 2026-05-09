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
      out.push([word, found]);
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
