/**
 * GET  /api/agents/weights — return current user's weight bundle
 * PUT  /api/agents/weights — replace it (writes a history row too)
 *
 * Requires an authenticated session. Dev mode also requires a real
 * session — `/api/dev-login` creates the user in `auth.users`, so the
 * cookie-based session is real even in DEV_BYPASS_AUTH mode. We use
 * the service-role client for the write itself to keep history-writes
 * atomic with the upsert.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { createClient as createServerSupabase } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  AGENT_NAMES,
  DEFAULT_WEIGHTS,
  WeightConstraintError,
  validateWeights,
  type WeightsBundle,
} from '@/lib/agents/weights';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SessionInfo {
  userId: string;
}

async function getSession(): Promise<SessionInfo | null> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  return { userId: user.id };
}

function bundleToJson(bundle: WeightsBundle): Record<string, number> {
  // Store as plain JSON numbers; the DB CHECK casts to NUMERIC.
  const out: Record<string, number> = {};
  for (const agent of AGENT_NAMES) {
    out[agent] = bundle[agent];
  }
  return out;
}

// ─── GET ─────────────────────────────────────────────────────────────

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('user_weight_settings')
    .select('weights, updated_at, created_at')
    .eq('user_id', session.userId)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: `db: ${error.message}` },
      { status: 500 },
    );
  }

  if (!data) {
    return NextResponse.json(
      {
        weights: DEFAULT_WEIGHTS,
        updated_at: null,
        created_at: null,
        is_default: true,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json(
    {
      weights: data.weights,
      updated_at: data.updated_at,
      created_at: data.created_at,
      is_default: false,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

// ─── PUT ─────────────────────────────────────────────────────────────

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  // Body shape: either {weights: {...}} or the bundle directly. Accept both.
  const candidate =
    body && typeof body === 'object' && 'weights' in (body as Record<string, unknown>)
      ? (body as { weights: unknown }).weights
      : body;

  let bundle: WeightsBundle;
  try {
    bundle = validateWeights(candidate);
  } catch (err) {
    if (err instanceof WeightConstraintError) {
      return NextResponse.json(
        {
          error: err.message,
          field: err.field,
          value: err.value ?? null,
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'validation failed' },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Snapshot the old weights for the history row (best-effort — if
  // none exists, before_weights stays null).
  const { data: existing } = await admin
    .from('user_weight_settings')
    .select('weights')
    .eq('user_id', session.userId)
    .maybeSingle();
  const beforeWeights =
    (existing as { weights?: Record<string, number> } | null)?.weights ?? null;

  const newRow = {
    user_id: session.userId,
    weights: bundleToJson(bundle),
  };

  const { data: upserted, error: upsertError } = await admin
    .from('user_weight_settings')
    .upsert(newRow, { onConflict: 'user_id' })
    .select('weights, updated_at, created_at')
    .single();
  if (upsertError) {
    return NextResponse.json(
      { error: `upsert: ${upsertError.message}` },
      { status: 500 },
    );
  }

  // History row. Skip if before == after (no-op save) to keep the
  // ledger meaningful.
  const sameAsBefore =
    beforeWeights !== null &&
    AGENT_NAMES.every(
      (a) => Number(beforeWeights[a]) === bundle[a],
    );
  if (!sameAsBefore) {
    const { error: historyError } = await admin
      .from('weight_settings_history')
      .insert({
        user_id: session.userId,
        before_weights: beforeWeights,
        after_weights: bundleToJson(bundle),
        source: 'user_manual',
      });
    if (historyError) {
      // History is best-effort — log but don't fail the upsert.
      console.warn(
        '[agents/weights PUT] history insert failed:',
        historyError.message,
      );
    }
  }

  return NextResponse.json({
    weights: upserted.weights,
    updated_at: upserted.updated_at,
    created_at: upserted.created_at,
    is_default: false,
  });
}
