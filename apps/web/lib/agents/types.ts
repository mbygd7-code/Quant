/**
 * TypeScript schemas for the 8-agent ledger tables (migrations 18-21).
 *
 * Mirrors `agents/db/models.py`. The Python side validates Postgres
 * round-trips with Pydantic; this side validates HTTP boundaries with
 * Zod. Whenever you change one, update the other — the schema-sync
 * test in `tests/agents/db/test_schema_parity.py` (M2) will guard
 * this.
 *
 * Where the two diverge intentionally:
 *
 *  * `score` is `number` here, `Decimal` in Python. JS doubles carry
 *    enough precision for NUMERIC(4,2); we round at I/O.
 *  * The Python `<Table>New` flavour mirrors the insert shape here as
 *    `<Table>Insert`. Keeps the TS naming idiomatic (matches Supabase
 *    type generation conventions).
 */
import { z } from 'zod';

// ─── Enums ──────────────────────────────────────────────────────────

export const agentNameSchema = z.enum([
  'soros',
  'taleb',
  'simons',
  'graham',
  'dow',
  'shiller',
  'keynes',
  'turing',
]);
export type AgentName = z.infer<typeof agentNameSchema>;

export const votingAgentSchema = z.enum([
  'simons',
  'graham',
  'dow',
  'shiller',
  'keynes',
  'taleb',
]);
export type VotingAgent = z.infer<typeof votingAgentSchema>;

export const signalGradeSchema = z.enum([
  'STRONG_BUY',
  'BUY',
  'HOLD',
  'CAUTION',
  'RISK',
]);
export type SignalGrade = z.infer<typeof signalGradeSchema>;

export const knowledgeTypeSchema = z.enum([
  'lesson',
  'pattern',
  'self_critique',
]);
export type KnowledgeType = z.infer<typeof knowledgeTypeSchema>;

export const weightSourceSchema = z.enum([
  'user_manual',
  'soros_recommendation',
  'admin',
  'migration',
]);
export type WeightSource = z.infer<typeof weightSourceSchema>;

// ─── Primitive constraints ──────────────────────────────────────────

const tickerSchema = z.string().regex(/^[A-Z0-9.\-]{1,12}$/);
const scoreSchema = z.number().gte(-2).lte(2);
const severitySchema = z.number().int().gte(1).lte(5);
const confidenceSchema = z.number().gte(0).lte(1);
const multiplierSchema = z.number().gte(0.5).lte(1.5);

// ─── 18 · agent_outputs ─────────────────────────────────────────────

export const agentOutputInsertSchema = z
  .object({
    agent_name: agentNameSchema,
    cycle_at: z.string().datetime({ offset: true }),
    ticker: tickerSchema.nullable().optional(),
    score: scoreSchema.nullable().optional(),
    severity: severitySchema.nullable().optional(),
    narrative: z.string().min(1),
    raw_payload: z.record(z.string(), z.unknown()).default({}),
    model: z.string().max(50).nullable().optional(),
    cost_estimate: z.number().nullable().optional(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.severity != null && row.agent_name !== 'taleb') {
      ctx.addIssue({
        code: 'custom',
        path: ['severity'],
        message: "severity is only valid when agent_name='taleb'",
      });
    }
  });
export type AgentOutputInsert = z.infer<typeof agentOutputInsertSchema>;

export const agentOutputSchema = z
  .object({
    id: z.string().uuid(),
    agent_name: agentNameSchema,
    cycle_at: z.string().datetime({ offset: true }),
    ticker: tickerSchema.nullable(),
    score: scoreSchema.nullable(),
    severity: severitySchema.nullable(),
    narrative: z.string().min(1),
    raw_payload: z.record(z.string(), z.unknown()),
    model: z.string().nullable(),
    cost_estimate: z.number().nullable(),
    created_at: z.string().datetime({ offset: true }),
  })
  .passthrough();
export type AgentOutput = z.infer<typeof agentOutputSchema>;

// ─── 19 · final_signals ─────────────────────────────────────────────

const _finalSignalShape = {
  ticker: tickerSchema,
  cycle_at: z.string().datetime({ offset: true }),
  signal_grade: signalGradeSchema,
  confidence: confidenceSchema.nullable().optional(),
  weighted_score: scoreSchema.nullable().optional(),
  weights_snapshot: z.record(z.string(), z.unknown()),
  narrative: z.string().min(1),
  taleb_severity: severitySchema.nullable().optional(),
  taleb_override: z.boolean().default(false),
  cost_estimate: z.number().nullable().optional(),
};

export const finalSignalInsertSchema = z.object(_finalSignalShape).strict();
export type FinalSignalInsert = z.infer<typeof finalSignalInsertSchema>;

export const finalSignalSchema = z
  .object({
    ..._finalSignalShape,
    id: z.string().uuid(),
    created_at: z.string().datetime({ offset: true }),
  })
  .passthrough();
export type FinalSignal = z.infer<typeof finalSignalSchema>;

// ─── 19 · signal_change_events ──────────────────────────────────────

export const signalChangeEventInsertSchema = z
  .object({
    ticker: tickerSchema,
    from_grade: signalGradeSchema.nullable().optional(),
    to_grade: signalGradeSchema,
    from_signal_id: z.string().uuid().nullable().optional(),
    to_signal_id: z.string().uuid(),
    reason: z.string().min(1),
    taleb_override: z.boolean().default(false),
    notified_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
export type SignalChangeEventInsert = z.infer<typeof signalChangeEventInsertSchema>;

// ─── 19 · daily_briefings ───────────────────────────────────────────

export const dailyBriefingInsertSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    headline: z.string().min(1).max(200),
    summary_md: z.string().min(1),
    top_stocks: z.array(z.record(z.string(), z.unknown())).default([]),
    risk_alerts: z.array(z.record(z.string(), z.unknown())).default([]),
    market_regime: z.string().nullable().optional(),
    weights_in_use: z.record(z.string(), z.unknown()).nullable().optional(),
    cost_estimate: z.number().nullable().optional(),
  })
  .strict();
export type DailyBriefingInsert = z.infer<typeof dailyBriefingInsertSchema>;

// ─── 20 · soros_weight_adjustments ──────────────────────────────────

export const sorosOverlaySchema = z.record(votingAgentSchema, multiplierSchema);
export type SorosOverlay = z.infer<typeof sorosOverlaySchema>;

export const sorosWeightAdjustmentInsertSchema = z
  .object({
    cycle_at: z.string().datetime({ offset: true }),
    overlay: sorosOverlaySchema,
    rationale: z.string().min(1),
    valid_until: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
export type SorosWeightAdjustmentInsert = z.infer<
  typeof sorosWeightAdjustmentInsertSchema
>;

// ─── 21 · agent_knowledge ───────────────────────────────────────────

export const agentKnowledgeInsertSchema = z
  .object({
    agent_name: agentNameSchema,
    knowledge_type: knowledgeTypeSchema,
    content_md: z.string().min(1),
    source_signal_id: z.string().uuid().nullable().optional(),
    confidence_at_time: confidenceSchema.nullable().optional(),
    outcome_observed: z.string().nullable().optional(),
    outcome_horizon_d: z.number().int().positive().nullable().optional(),
    realized_return: z.number().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
  })
  .strict();
export type AgentKnowledgeInsert = z.infer<typeof agentKnowledgeInsertSchema>;
