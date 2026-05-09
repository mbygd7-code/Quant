'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, RefreshCw, Save } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  AGENT_NAMES,
  DEFAULT_WEIGHTS,
  MAX_WEIGHT,
  MIN_WEIGHT,
  SUM_TARGET,
  SUM_TOLERANCE,
  TALEB_MIN,
  type AgentSlug,
  type WeightsBundle,
} from '@/lib/agents/weights';

interface AgentMeta {
  slug: AgentSlug;
  name: string;
  domain: string;
  description: string;
  rationale: string;
}

const AGENTS: AgentMeta[] = [
  {
    slug: 'simons',
    name: 'Simons',
    domain: '정량 분석',
    description: 'sklearn GBM 기반 종목 예측 (PC 워커)',
    rationale: '데이터 기반 정량 시그널. 시장 효율을 신뢰할수록 비중 ↑',
  },
  {
    slug: 'graham',
    name: 'Graham',
    domain: '가치 분석',
    description: '본질가치·안전마진 평가',
    rationale: '저평가 종목 발굴 우선이라면 비중 ↑',
  },
  {
    slug: 'dow',
    name: 'Dow',
    domain: '기술적 분석',
    description: '3-축 추세 진단 + 거래량 검증',
    rationale: '추세 추종형 거래라면 비중 ↑',
  },
  {
    slug: 'shiller',
    name: 'Shiller',
    domain: '시장 사이클',
    description: '거품·심리 진단',
    rationale: '과열·공포 국면 회피가 중요하면 비중 ↑',
  },
  {
    slug: 'keynes',
    name: 'Keynes',
    domain: '매크로',
    description: '정책·매크로 변수의 섹터 영향',
    rationale: '금리·환율 민감 섹터 비중이 큰 포트폴리오라면 비중 ↑',
  },
  {
    slug: 'taleb',
    name: 'Taleb',
    domain: '리스크 검증',
    description: '비대칭·테일 리스크 경고 (10% 이상 강제)',
    rationale: '하방 보호 우선이면 비중 ↑. 절대 10% 미만 불가',
  },
];

const FETCH_URL = '/api/agents/weights';

interface ApiResponse {
  weights: Record<string, number>;
  is_default: boolean;
  updated_at: string | null;
  created_at: string | null;
}

interface ApiError {
  error: string;
  field?: string;
}

interface Props {
  initial: ApiResponse;
}

function bounds(slug: AgentSlug): [number, number] {
  return slug === 'taleb' ? [TALEB_MIN, MAX_WEIGHT] : [MIN_WEIGHT, MAX_WEIGHT];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function WeightSliderForm({ initial }: Props) {
  const initialBundle = useMemo<WeightsBundle>(() => {
    const out = {} as WeightsBundle;
    for (const slug of AGENT_NAMES) {
      out[slug] = Number(initial.weights[slug] ?? DEFAULT_WEIGHTS[slug]);
    }
    return out;
  }, [initial.weights]);

  const [weights, setWeights] = useState<WeightsBundle>(initialBundle);
  const [submitting, setSubmitting] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(initial.updated_at);
  const [isDefault, setIsDefault] = useState(initial.is_default);
  // toLocaleString resolves to '오후' on Node and 'PM' on Chromium for
  // 'ko-KR', so SSR-rendered text mismatches client text. Defer the
  // human-readable label to after hydration.
  const [savedAtDisplay, setSavedAtDisplay] = useState<string | null>(null);
  useEffect(() => {
    if (!savedAt) {
      setSavedAtDisplay(null);
      return;
    }
    setSavedAtDisplay(new Date(savedAt).toLocaleString('ko-KR'));
  }, [savedAt]);

  // Sum validation in real time so the user sees feedback before submitting.
  const sum = useMemo(
    () => AGENT_NAMES.reduce((s, a) => s + weights[a], 0),
    [weights],
  );
  const drift = sum - SUM_TARGET;
  const sumOk = Math.abs(drift) <= SUM_TOLERANCE;

  const dirty = useMemo(
    () => AGENT_NAMES.some((a) => round2(weights[a]) !== round2(initialBundle[a])),
    [weights, initialBundle],
  );

  const handleSlider = (slug: AgentSlug, value: number) => {
    const [lo, hi] = bounds(slug);
    setWeights((prev) => ({ ...prev, [slug]: clamp(value, lo, hi) }));
  };

  const handleReset = () => setWeights(initialBundle);
  const handleResetDefaults = () => setWeights({ ...DEFAULT_WEIGHTS });

  const handleAutoBalance = () => {
    // Pin Taleb (user just changed it, treat as fixed) and proportionally
    // distribute the remaining 1.00 - taleb across the other 5 by their
    // current ratio. If everyone else is zero, fall back to even split.
    const target = SUM_TARGET - weights.taleb;
    const others = AGENT_NAMES.filter((a) => a !== 'taleb');
    const othersSum = others.reduce((s, a) => s + weights[a], 0);
    if (othersSum === 0) {
      const share = round2(target / others.length);
      const next = { ...weights };
      for (const a of others) next[a] = share;
      // Absorb rounding drift into simons.
      const driftFix = round2(target - others.reduce((s, a) => s + next[a], 0));
      next.simons = round2(next.simons + driftFix);
      setWeights(next);
      return;
    }
    const next = { ...weights };
    for (const a of others) {
      const [lo, hi] = bounds(a);
      next[a] = round2(clamp((weights[a] / othersSum) * target, lo, hi));
    }
    // Drift absorbed by the largest non-taleb weight.
    const newOthersSum = others.reduce((s, a) => s + next[a], 0);
    const fix = round2(target - newOthersSum);
    if (fix !== 0) {
      let largest = others[0];
      for (const a of others) if (next[a] > next[largest]) largest = a;
      next[largest] = round2(next[largest] + fix);
    }
    setWeights(next);
  };

  const handleSave = async () => {
    setSubmitting(true);
    try {
      const payload = { weights };
      const res = await fetch(FETCH_URL, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as ApiResponse | ApiError;
      if (!res.ok) {
        const err = body as ApiError;
        toast.error(`${err.field ? `[${err.field}] ` : ''}${err.error}`);
        return;
      }
      const data = body as ApiResponse;
      setSavedAt(data.updated_at);
      setIsDefault(false);
      // Server rounds to 2 decimals — sync local state to match.
      const next = {} as WeightsBundle;
      for (const slug of AGENT_NAMES) {
        next[slug] = Number(data.weights[slug] ?? DEFAULT_WEIGHTS[slug]);
      }
      setWeights(next);
      toast.success('가중치 저장됨');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '저장 실패');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Status banner */}
      <Card>
        <CardContent className="flex items-center justify-between gap-3 p-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-txt-muted">합계</span>
            <span
              className={cn(
                'font-mono tabular-nums',
                sumOk ? 'text-status-success' : 'text-status-danger',
              )}
            >
              {(sum * 100).toFixed(2)}%
            </span>
            {sumOk ? (
              <Check className="h-3.5 w-3.5 text-status-success" />
            ) : (
              <AlertCircle className="h-3.5 w-3.5 text-status-danger" />
            )}
            {!sumOk && (
              <span className="text-xs text-status-danger ml-1">
                {drift > 0 ? '+' : ''}
                {(drift * 100).toFixed(2)}%p — 100%로 맞춰야 저장 가능
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isDefault && (
              <Badge variant="outline" className="text-xs">
                기본값
              </Badge>
            )}
            {savedAtDisplay && (
              <span className="text-xs text-txt-muted">
                마지막 저장 {savedAtDisplay}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Sliders */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {AGENTS.map((agent) => {
          const [lo, hi] = bounds(agent.slug);
          const value = weights[agent.slug];
          const pct = (value * 100).toFixed(0);
          return (
            <Card key={agent.slug} className="overflow-hidden">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{agent.name}</h3>
                      <Badge variant="outline" className="text-[10px]">
                        {agent.domain}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-txt-secondary">
                      {agent.description}
                    </p>
                  </div>
                  <span className="font-mono tabular-nums text-lg shrink-0">
                    {pct}%
                  </span>
                </div>

                <Slider
                  min={Math.round(lo * 100)}
                  max={Math.round(hi * 100)}
                  step={1}
                  value={[Math.round(value * 100)]}
                  onValueChange={(v) => handleSlider(agent.slug, v[0] / 100)}
                />

                <div className="flex items-center justify-between text-[11px] text-txt-muted">
                  <span>
                    {Math.round(lo * 100)}% – {Math.round(hi * 100)}%
                  </span>
                  <span className="text-right max-w-[60%]">
                    {agent.rationale}
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Action bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={!dirty || submitting}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            되돌리기
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleResetDefaults}
            disabled={submitting}
          >
            기본값 적용
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAutoBalance}
            disabled={submitting || sumOk}
            title="Taleb 비중을 고정하고 나머지 5명을 비례 정규화해 합계 100% 맞춤"
          >
            자동 합산 100%
          </Button>
        </div>
        <Button
          type="button"
          onClick={handleSave}
          disabled={!dirty || !sumOk || submitting}
          className="bg-gradient-brand text-white hover:opacity-90"
        >
          <Save className="h-3.5 w-3.5 mr-1" />
          {submitting ? '저장 중…' : '저장'}
        </Button>
      </div>
    </div>
  );
}
