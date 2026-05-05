'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CheckCircle2, AlertTriangle, FlaskConical } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { saveWeightConfig } from '@/app/(admin)/weights/actions';

interface State {
  version: string;
  notes: string;
  global_market_weight: number;
  sector_weight: number;
  related_us_stock_weight: number;
  news_sentiment_weight: number;
  fundamental_weight: number;
  volume_flow_weight: number;
  risk_penalty_weight: number;
  signal_threshold_strong: number;
  signal_threshold_interest: number;
  signal_threshold_neutral: number;
  signal_threshold_caution: number;
}

const WEIGHT_FIELDS: Array<{ key: keyof State; label: string }> = [
  { key: 'global_market_weight', label: '글로벌 시장' },
  { key: 'sector_weight', label: '섹터 온도' },
  { key: 'related_us_stock_weight', label: '미국 관련주' },
  { key: 'news_sentiment_weight', label: '뉴스 감성' },
  { key: 'fundamental_weight', label: '펀더멘털' },
  { key: 'volume_flow_weight', label: '수급/거래량' },
  { key: 'risk_penalty_weight', label: '리스크 패널티' },
];

const THRESHOLD_FIELDS: Array<{ key: keyof State; label: string; tone: string }> = [
  { key: 'signal_threshold_strong', label: '강한 관심 ≥', tone: 'text-brand-purple' },
  { key: 'signal_threshold_interest', label: '관심 ≥', tone: 'text-brand-purple' },
  { key: 'signal_threshold_neutral', label: '관망 ≥', tone: 'text-txt-secondary' },
  { key: 'signal_threshold_caution', label: '주의 ≥', tone: 'text-status-warning' },
];

export function WeightsForm({ initial }: { initial: State }) {
  const router = useRouter();
  const [state, setState] = useState<State>(initial);
  const [pending, startTransition] = useTransition();

  const sum = useMemo(
    () =>
      state.global_market_weight +
      state.sector_weight +
      state.related_us_stock_weight +
      state.news_sentiment_weight +
      state.fundamental_weight +
      state.volume_flow_weight +
      state.risk_penalty_weight,
    [state],
  );
  const sumOk = Math.abs(sum - 1.0) < 0.001;

  const monotonicOk =
    state.signal_threshold_strong > state.signal_threshold_interest &&
    state.signal_threshold_interest > state.signal_threshold_neutral &&
    state.signal_threshold_neutral > state.signal_threshold_caution;

  const notesOk = state.notes.trim().length >= 10;
  const canSave = sumOk && monotonicOk && notesOk && state.version.trim().length >= 3;

  function setField<K extends keyof State>(key: K, value: State[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    startTransition(async () => {
      const res = await saveWeightConfig(state);
      if (res.error) toast.error(`저장 실패: ${res.error}`);
      else {
        toast.success('새 버전으로 저장됨 (비활성). 우측에서 [활성화]하세요.');
        router.refresh();
      }
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-heading">가중치 편집</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="version">버전 라벨 *</Label>
            <Input
              id="version"
              placeholder="2026-05-05"
              value={state.version}
              onChange={(e) => setField('version', e.target.value)}
            />
          </div>
        </div>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">7요소 가중치</h3>
            <span
              className={`flex items-center gap-1 text-xs font-mono ${
                sumOk ? 'text-status-success' : 'text-status-error'
              }`}
            >
              {sumOk ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              합계 {sum.toFixed(2)} {sumOk ? '✓' : '(1.00 필요)'}
            </span>
          </div>
          <div className="space-y-2">
            {WEIGHT_FIELDS.map(({ key, label }) => (
              <div key={key} className="flex items-center gap-3">
                <Label className="w-28 text-xs">{label}</Label>
                <Slider
                  min={0}
                  max={1}
                  step={0.05}
                  value={[state[key] as number]}
                  onValueChange={(v) => setField(key, v[0] as State[typeof key])}
                  className="flex-1"
                />
                <span className="w-12 text-right font-mono text-xs tabular-nums">
                  {(state[key] as number).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">신호 임계값</h3>
            <span
              className={`flex items-center gap-1 text-xs ${
                monotonicOk ? 'text-status-success' : 'text-status-error'
              }`}
            >
              {monotonicOk ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              {monotonicOk ? '단조 감소 OK' : '단조 감소 위반'}
            </span>
          </div>
          <div className="space-y-2">
            {THRESHOLD_FIELDS.map(({ key, label, tone }) => (
              <div key={key} className="flex items-center gap-3">
                <Label className={`w-28 text-xs ${tone}`}>{label}</Label>
                <Slider
                  min={0}
                  max={1}
                  step={0.01}
                  value={[state[key] as number]}
                  onValueChange={(v) => setField(key, v[0] as State[typeof key])}
                  className="flex-1"
                />
                <span className="w-12 text-right font-mono text-xs tabular-nums">
                  {(state[key] as number).toFixed(2)}
                </span>
              </div>
            ))}
            <p className="text-[11px] text-txt-muted">
              위험 등급 = 주의 임계값 미만 ({state.signal_threshold_caution.toFixed(2)})
            </p>
          </div>
        </section>

        <div className="space-y-1.5">
          <Label htmlFor="notes">변경 사유 * (10자 이상)</Label>
          <textarea
            id="notes"
            className="w-full rounded-md border border-border bg-bg-secondary p-2 text-sm min-h-[60px]"
            placeholder="예: 뉴스 감성 비중 +0.05 (최근 LLM 점수 분포 안정화)"
            value={state.notes}
            onChange={(e) => setField('notes', e.target.value)}
          />
          {!notesOk && state.notes.length > 0 && (
            <p className="text-[11px] text-status-error">변경 사유 10자 이상 필요</p>
          )}
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            disabled
            title="Prompt 16에서 활성화 예정"
          >
            <FlaskConical className="h-4 w-4 mr-1" />
            백테스트 미리보기 (~5분)
          </Button>
          <Button
            type="button"
            className="ml-auto bg-gradient-brand text-white"
            onClick={handleSave}
            disabled={!canSave || pending}
          >
            {pending ? '저장 중...' : '버전으로 저장'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
