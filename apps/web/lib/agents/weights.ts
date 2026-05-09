/**
 * TypeScript twin of `agents/weights/` (Python).
 *
 * Both ports share the same constants, the same zod-equivalent
 * validator, and the same pin-and-scale normalizer. Keep them in
 * sync — the API handler (TS) and the cron jobs (Python) must agree
 * on what a "valid" bundle looks like or the same payload gets
 * accepted on one side and rejected on the other.
 *
 * Numeric precision
 * -----------------
 * JS doubles carry ~15 significant decimal digits, more than enough
 * for the 4-decimal NUMERIC(4,2) we store in Postgres. We round to 2
 * decimals at the I/O boundary (the same step Python does with
 * `Decimal.quantize`) so the JSON we send to Supabase matches the
 * column scale exactly.
 *
 * Both file is server-and-browser safe (no `import 'server-only'`):
 * the slider form on the client uses `validateWeights` for live
 * feedback before the API round-trip.
 */
import { z } from 'zod';

// ─── Constants (mirror agents/weights/constants.py) ──────────────────

export const AGENT_NAMES = [
  'simons',
  'graham',
  'dow',
  'shiller',
  'keynes',
  'taleb',
] as const;

export type AgentSlug = (typeof AGENT_NAMES)[number];

export const MIN_WEIGHT = 0.05;
export const MAX_WEIGHT = 0.4;
export const TALEB_MIN = 0.1;
export const SUM_TARGET = 1.0;
export const SUM_TOLERANCE = 0.001;

export const DEFAULT_WEIGHTS: WeightsBundle = {
  simons: 0.2,
  graham: 0.18,
  dow: 0.18,
  shiller: 0.13,
  keynes: 0.18,
  taleb: 0.13,
};

// ─── Types + zod schema ──────────────────────────────────────────────

export interface WeightsBundle {
  simons: number;
  graham: number;
  dow: number;
  shiller: number;
  keynes: number;
  taleb: number;
}

/**
 * Permissive per-agent range. Matches the DB CHECK from migration 20:
 * 0.05..0.40 for all but taleb (0.10..0.40). The sum-equals-1
 * invariant is checked separately in `validateWeights` because zod
 * can't easily express it.
 */
export const weightsBundleSchema = z
  .object({
    simons: z.number().min(MIN_WEIGHT).max(MAX_WEIGHT),
    graham: z.number().min(MIN_WEIGHT).max(MAX_WEIGHT),
    dow: z.number().min(MIN_WEIGHT).max(MAX_WEIGHT),
    shiller: z.number().min(MIN_WEIGHT).max(MAX_WEIGHT),
    keynes: z.number().min(MIN_WEIGHT).max(MAX_WEIGHT),
    taleb: z.number().min(TALEB_MIN).max(MAX_WEIGHT),
  })
  .strict();

// ─── Errors ──────────────────────────────────────────────────────────

export class WeightConstraintError extends Error {
  constructor(
    public readonly field: string,
    message: string,
    public readonly value?: unknown,
  ) {
    super(`${field}: ${message}`);
    this.name = 'WeightConstraintError';
  }
}

// ─── Validator (strict, raises on out-of-spec) ───────────────────────

/**
 * Strict gate. Returns the bundle on success; throws
 * `WeightConstraintError` on any per-agent or sum violation.
 *
 * zod ValidationError is always translated to WeightConstraintError
 * so callers have a single exception type.
 */
export function validateWeights(input: unknown): WeightsBundle {
  let bundle: WeightsBundle;
  try {
    bundle = weightsBundleSchema.parse(input);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0];
      const field =
        issue && issue.path.length > 0 ? String(issue.path[0]) : '<root>';
      throw new WeightConstraintError(
        field,
        issue?.message ?? 'invalid',
        (issue as { input?: unknown } | undefined)?.input,
      );
    }
    throw err;
  }

  // Per-agent re-check with friendlier messages (zod's defaults are
  // technical; we want "weight 0.04 below floor 0.05").
  for (const agent of AGENT_NAMES) {
    const v = bundle[agent];
    const lo = agent === 'taleb' ? TALEB_MIN : MIN_WEIGHT;
    const hi = MAX_WEIGHT;
    if (v < lo) {
      throw new WeightConstraintError(
        agent,
        `weight ${v} below floor ${lo}`,
        v,
      );
    }
    if (v > hi) {
      throw new WeightConstraintError(
        agent,
        `weight ${v} above ceiling ${hi}`,
        v,
      );
    }
  }

  // Sum invariant.
  const total = AGENT_NAMES.reduce((s, a) => s + bundle[a], 0);
  const drift = Math.abs(total - SUM_TARGET);
  if (drift > SUM_TOLERANCE) {
    throw new WeightConstraintError(
      '<sum>',
      `weights must sum to ${SUM_TARGET} (got ${total.toFixed(
        6,
      )}, drift ${drift.toFixed(6)} > tolerance ${SUM_TOLERANCE}). ` +
        'Use normalizeWeights() if you want auto-correction.',
      total,
    );
  }

  return bundle;
}

// ─── Normalizer (pin-and-scale, O(n)) ────────────────────────────────

function bounds(agent: AgentSlug): [number, number] {
  return agent === 'taleb' ? [TALEB_MIN, MAX_WEIGHT] : [MIN_WEIGHT, MAX_WEIGHT];
}

function snapToTwoDecimals(values: WeightsBundle): WeightsBundle {
  const snapped = {} as WeightsBundle;
  for (const agent of AGENT_NAMES) {
    snapped[agent] = Math.round(values[agent] * 100) / 100;
  }
  const sum = AGENT_NAMES.reduce((s, a) => s + snapped[a], 0);
  const drift = Math.round((SUM_TARGET - sum) * 100) / 100;
  if (drift !== 0) {
    let largest: AgentSlug = 'simons';
    for (const agent of AGENT_NAMES) {
      if (snapped[agent] > snapped[largest]) largest = agent;
    }
    snapped[largest] = Math.round((snapped[largest] + drift) * 100) / 100;
  }
  return snapped;
}

/**
 * Best-effort sum-to-1 correction. Pins any out-of-range agent at its
 * floor/ceiling, scales the remaining agents proportionally, repeats
 * up to len(AGENT_NAMES) times.
 *
 * If the input is all-zero, falls back to DEFAULT_WEIGHTS.
 *
 * Throws `WeightConstraintError` only when no valid bundle can satisfy
 * both per-agent ranges and sum-to-1 simultaneously (geometrically
 * impossible with our 0.05-0.40 / 0.10-0.40 bounds for any plausible
 * input).
 */
export function normalizeWeights(input: Partial<WeightsBundle>): WeightsBundle {
  // Coerce + presence check.
  const values = {} as Record<AgentSlug, number>;
  for (const agent of AGENT_NAMES) {
    const v = input[agent];
    if (typeof v !== 'number' || Number.isNaN(v)) {
      throw new WeightConstraintError(agent, 'missing weight');
    }
    values[agent] = v;
  }

  const allZero = AGENT_NAMES.every((a) => values[a] === 0);
  if (allZero) return { ...DEFAULT_WEIGHTS };

  const pinned: Partial<Record<AgentSlug, number>> = {};
  let free: Partial<Record<AgentSlug, number>> = { ...values };

  for (let iter = 0; iter <= AGENT_NAMES.length; iter++) {
    const pinnedSum = Object.values(pinned).reduce(
      (s, v) => s + (v ?? 0),
      0,
    );
    const freeAgents = (Object.keys(free) as AgentSlug[]).filter(
      (a) => free[a] !== undefined,
    );
    const freeSum = freeAgents.reduce((s, a) => s + (free[a] ?? 0), 0);
    if (freeSum === 0) break;

    const scale = (SUM_TARGET - pinnedSum) / freeSum;
    const scaled = {} as Partial<Record<AgentSlug, number>>;
    for (const a of freeAgents) {
      scaled[a] = (free[a] ?? 0) * scale;
    }

    const newPins: Partial<Record<AgentSlug, number>> = {};
    for (const a of freeAgents) {
      const v = scaled[a]!;
      const [lo, hi] = bounds(a);
      if (v < lo) newPins[a] = lo;
      else if (v > hi) newPins[a] = hi;
    }

    if (Object.keys(newPins).length === 0) {
      // Converged.
      free = scaled;
      break;
    }

    for (const a of Object.keys(newPins) as AgentSlug[]) {
      pinned[a] = newPins[a]!;
      delete (free as Partial<Record<AgentSlug, number>>)[a];
    }
  }

  const combined = { ...pinned, ...free } as Record<AgentSlug, number>;
  const drift = Math.abs(
    AGENT_NAMES.reduce((s, a) => s + combined[a], 0) - SUM_TARGET,
  );
  if (drift > SUM_TOLERANCE * 10) {
    throw new WeightConstraintError(
      '<all>',
      'could not normalize within bounds — input violates both per-agent range and sum-to-1 in a way that has no fix',
      combined,
    );
  }

  return snapToTwoDecimals(combined as WeightsBundle);
}
