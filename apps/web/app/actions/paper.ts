'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Reset the Soros paper-trading portfolio with a new starting capital.
 *
 * Mid-run capital edits would corrupt the P&L accounting, so changing
 * the amount is explicitly a RESET: trades/positions/snapshots are
 * wiped and the bot restarts from the new capital at the next cycle.
 * The UI shows a confirm dialog spelling this out.
 */
const schema = z.object({
  capital: z
    .number()
    .int()
    .min(1_000_000, '최소 100만원')
    .max(100_000_000_000, '최대 1,000억원'),
});

export async function resetPaperPortfolioAction(input: { capital: number }) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? '잘못된 금액' };
  }
  const capital = parsed.data.capital;
  try {
    const sb = createAdminClient();
    // Order matters: wipe ledgers first, then reset the config row.
    await sb.from('paper_bot_trades').delete().neq('id', 0);
    await sb.from('paper_bot_positions').delete().neq('qty', 0);
    await sb.from('paper_bot_snapshots').delete().neq('total_value', -1);
    const { error } = await sb
      .from('paper_config')
      .update({
        initial_capital: capital,
        cash: capital,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', 1);
    if (error) return { error: error.message };
    revalidatePath('/paper');
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : '리셋 실패' };
  }
}
