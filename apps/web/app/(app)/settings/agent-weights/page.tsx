import { redirect } from 'next/navigation';

import { Card, CardContent } from '@/components/ui/card';
import { createClient } from '@/lib/supabase/server';
import { DEV_BYPASS_AUTH } from '@/lib/supabase/query-client';
import { createAdminClient } from '@/lib/supabase/admin';
import { DEFAULT_WEIGHTS } from '@/lib/agents/weights';
import { WeightSliderForm } from '@/components/agents/weight-slider-form';

export const dynamic = 'force-dynamic';

export default async function AgentWeightsPage() {
  // Standard session check — dev mode also requires a real session,
  // since /api/dev-login creates the auth.users row before logging in.
  let userId: string | null = null;
  if (!DEV_BYPASS_AUTH) {
    const sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) redirect('/login');
    userId = user.id;
  } else {
    const sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    userId = user?.id ?? null;
  }

  let initial: {
    weights: Record<string, number>;
    is_default: boolean;
    updated_at: string | null;
    created_at: string | null;
  };
  if (!userId) {
    // Dev mode without an active session — show defaults so the page
    // renders, but the save button will fail with 401 until the user
    // hits /api/dev-login.
    initial = {
      weights: DEFAULT_WEIGHTS as unknown as Record<string, number>,
      is_default: true,
      updated_at: null,
      created_at: null,
    };
  } else {
    const admin = createAdminClient();
    const { data } = await admin
      .from('user_weight_settings')
      .select('weights, updated_at, created_at')
      .eq('user_id', userId)
      .maybeSingle();
    initial = data
      ? {
          weights: data.weights as Record<string, number>,
          is_default: false,
          updated_at: data.updated_at as string | null,
          created_at: data.created_at as string | null,
        }
      : {
          weights: DEFAULT_WEIGHTS as unknown as Record<string, number>,
          is_default: true,
          updated_at: null,
          created_at: null,
        };
  }

  return (
    <div className="space-y-5 fade-in">
      <header>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          AI 가중치
        </h1>
        <p className="mt-1 text-sm text-txt-secondary">
          6명 분석가의 의견 비중을 조정합니다. 합계는 100%, 각 슬라이더는 5%–40%
          (Taleb은 10%–40%) 범위 안에서 움직입니다. Soros가 시장 국면에 따라
          ±50% 임시 오버레이를 적용할 수 있지만, 본인 설정은 그대로 보존됩니다.
        </p>
      </header>

      <WeightSliderForm initial={initial} />

      <Card>
        <CardContent className="p-4 text-xs text-txt-muted leading-relaxed">
          <p className="font-medium mb-1 text-txt-secondary">가중치 시스템 안내</p>
          <ul className="list-disc list-inside space-y-1">
            <li>
              모든 변경 이력은 <code>weight_settings_history</code>에 기록됩니다.
            </li>
            <li>
              저장된 값은 매일 분석 사이클(07:00 / 12:00 / 16:00 KST)에 즉시
              반영됩니다.
            </li>
            <li>
              Taleb 가중치 10% 하한은 정책상 강제됩니다 (CLAUDE.md §3-A · 위험
              상시 검증).
            </li>
            <li>
              합계 100% 미만/초과 시 [자동 합산 100%] 버튼으로 비례 정규화할 수
              있습니다.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
