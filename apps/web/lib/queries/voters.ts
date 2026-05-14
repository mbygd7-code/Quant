/**
 * Voter-breakdown reader — fetches the per-character scores
 * (graham/dow/turing/shiller/keynes/taleb) for a single ticker from
 * `agent_outputs` to feed the VoterBreakdown UI card on the stock
 * detail page.
 *
 * Joins to `final_signals` to find the canonical cycle_at (so we show
 * the same cycle's voter set that produced the user-facing grade).
 */
import { getQueryClient } from '@/lib/supabase/query-client';

export interface VoterRow {
  agent_name: string;
  score: number;
  narrative: string | null;
  model: string | null;
  raw_payload: Record<string, unknown> | null;
}

export interface VoterBreakdown {
  cycle_at: string;
  signal_grade: string;
  weighted_score: number | null;
  confidence: number | null;
  weights_snapshot: Record<string, number> | null;
  narrative: string;
  taleb_severity: number | null;
  taleb_override: boolean;
  voters: VoterRow[];
}

const VOTING_AGENTS = ['simons', 'graham', 'dow', 'turing', 'shiller', 'keynes', 'taleb'] as const;

export async function getVoterBreakdown(ticker: string): Promise<VoterBreakdown | null> {
  const sb = await getQueryClient();

  // 1) Latest final_signals row for this ticker (the canonical cycle).
  const { data: signal } = await sb
    .from('final_signals')
    .select(
      'cycle_at, signal_grade, weighted_score, confidence, weights_snapshot, narrative, taleb_severity, taleb_override',
    )
    .eq('ticker', ticker)
    .order('cycle_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!signal) return null;

  // 2) All voter outputs from the same cycle. Strict cycle_at equality
  //    so we never mix runs (Phase 2 cron is 3×/day).
  const { data: voters } = await sb
    .from('agent_outputs')
    .select('agent_name, score, narrative, model, raw_payload')
    .eq('ticker', ticker)
    .eq('cycle_at', signal.cycle_at)
    .in('agent_name', VOTING_AGENTS as unknown as string[]);

  return {
    cycle_at: signal.cycle_at as string,
    signal_grade: signal.signal_grade as string,
    weighted_score: signal.weighted_score as number | null,
    confidence: signal.confidence as number | null,
    weights_snapshot: signal.weights_snapshot as Record<string, number> | null,
    narrative: signal.narrative as string,
    taleb_severity: signal.taleb_severity as number | null,
    taleb_override: Boolean(signal.taleb_override),
    voters: ((voters ?? []) as VoterRow[]).sort((a, b) => {
      // Keep a stable display order (matches M4_CHARACTER_ORDER).
      const order: Record<string, number> = {
        graham: 0, dow: 1, turing: 2, shiller: 3, keynes: 4, taleb: 5, simons: 6,
      };
      return (order[a.agent_name] ?? 99) - (order[b.agent_name] ?? 99);
    }),
  };
}
