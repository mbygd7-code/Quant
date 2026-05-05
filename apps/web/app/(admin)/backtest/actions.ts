'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { randomUUID } from 'crypto';

import { getAdminWriteClient, recordAudit } from '@/lib/audit';
import { DEV_BYPASS_AUTH } from '@/lib/supabase/query-client';

const startSchema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  strategy:   z.enum(['score_above_065', 'strong_only', 'top5_per_day']),
  weight_config_id: z.string().nullable().optional(),
});
type StartInput = z.infer<typeof startSchema>;

export async function startBacktest(
  raw: StartInput,
): Promise<{ ok?: true; job_id?: string; mode?: 'mock' | 'live'; error?: string }> {
  const parsed = startSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.message };

  const sb = getAdminWriteClient();
  const job_id = randomUUID();

  const { error } = await sb.from('backtest_jobs').insert({
    id: job_id,
    status: 'queued',
    progress: 0,
    params: parsed.data,
  });
  if (error) return { error: error.message };

  const repo = process.env.GITHUB_REPO;
  const pat = process.env.GITHUB_PAT;
  const mockMode = DEV_BYPASS_AUTH || !repo || !pat;

  if (mockMode) {
    await sb
      .from('backtest_jobs')
      .update({
        status: 'completed',
        progress: 100,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      })
      .eq('id', job_id);
    await recordAudit({
      action: 'backtest.start',
      resource_type: 'backtest_jobs',
      resource_id: job_id,
      changes: { params: parsed.data, mode: 'mock' },
    });
    revalidatePath('/backtest');
    return { ok: true, job_id, mode: 'mock' };
  }

  const dispatchRes = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/backtest.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          job_id,
          start_date: parsed.data.start_date,
          end_date: parsed.data.end_date,
          strategy: parsed.data.strategy,
          weight_config_id: parsed.data.weight_config_id ?? '',
        },
      }),
    },
  );
  if (!dispatchRes.ok) {
    const text = await dispatchRes.text();
    await sb
      .from('backtest_jobs')
      .update({
        status: 'failed',
        error: `dispatch ${dispatchRes.status}: ${text.slice(0, 500)}`,
        completed_at: new Date().toISOString(),
      })
      .eq('id', job_id);
    return { error: `GitHub dispatch failed: ${dispatchRes.status}` };
  }

  await recordAudit({
    action: 'backtest.start',
    resource_type: 'backtest_jobs',
    resource_id: job_id,
    changes: { params: parsed.data, mode: 'live' },
  });
  revalidatePath('/backtest');
  return { ok: true, job_id, mode: 'live' };
}

export async function fetchJobStatus(job_id: string) {
  const sb = getAdminWriteClient();
  const { data } = await sb
    .from('backtest_jobs')
    .select('id, status, progress, result_url, error, run_url, started_at, completed_at, params')
    .eq('id', job_id)
    .maybeSingle();
  return data;
}
