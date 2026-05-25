import Link from 'next/link';
import {
  ArrowLeft,
  ChartLine,
  CheckCircle2,
  MessageSquareText,
  ShieldAlert,
  Target,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CalibrationChart } from '@/components/admin/calibration-chart';
import { getQueryClient } from '@/lib/supabase/query-client';
import { gradeBand } from '@/lib/agents/grade';
import { type SignalGrade } from '@/lib/agents/types';

export const dynamic = 'force-dynamic';

interface HitRateRow {
  signal_grade: SignalGrade;
  n_1d: number;
  hit_rate_1d: number | null;
  avg_return_1d: number | null;
  n_5d: number;
  hit_rate_5d: number | null;
  avg_return_5d: number | null;
  n_10d: number;
  hit_rate_10d: number | null;
  avg_return_10d: number | null;
}

interface CalibrationRow {
  confidence_decile: number;
  decile_low: number;
  decile_high: number;
  n_signals: number;
  avg_confidence: number;
  actual_hit_rate_5d: number;
  avg_return_5d: number | null;
}

interface OverrideRow {
  n_overrides: number;
  override_avg_return_10d: number | null;
  override_loss_5pct_rate: number | null;
  n_baseline: number;
  baseline_avg_return_10d: number | null;
  baseline_loss_5pct_rate: number | null;
}

interface FeedbackRow {
  feedback_id: string;
  feedback_date: string;
  ticker: string | null;
  accuracy_score: number | null;
  usefulness_score: number | null;
  signal_grade: SignalGrade | null;
  return_5d: number | null;
}

const GRADE_ORDER: SignalGrade[] = ['STRONG_BUY', 'BUY', 'HOLD', 'CAUTION', 'RISK'];

function pct(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${(Number(n) * 100).toFixed(digits)}%`;
}

function pctSigned(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n) * 100;
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

/** RMSE between bucket avg_confidence and actual_hit_rate_5d (calibration error). */
function calibrationRmse(rows: CalibrationRow[]): number | null {
  const points = rows.filter((r) => r.n_signals > 0);
  if (points.length === 0) return null;
  const sumSq = points.reduce(
    (acc, r) => acc + Math.pow(r.avg_confidence - r.actual_hit_rate_5d, 2),
    0,
  );
  return Math.sqrt(sumSq / points.length);
}

function returnTone(v: number | null | undefined): string {
  if (v == null) return 'text-txt-muted';
  if (v > 0) return 'text-status-success';
  if (v < 0) return 'text-status-danger';
  return 'text-txt-secondary';
}

export default async function AccuracyPage() {
  const sb = await getQueryClient();

  const [hitRes, calibRes, overrideRes, feedbackRes, signalCountRes] = await Promise.all([
    sb.from('v_signal_hit_rate').select('*'),
    sb.from('v_signal_calibration').select('*').order('confidence_decile'),
    sb.from('v_taleb_override_effectiveness').select('*').maybeSingle(),
    sb
      .from('v_feedback_signal_link')
      .select('*')
      .order('feedback_created_at', { ascending: false })
      .limit(20),
    sb.from('final_signals').select('id', { count: 'exact', head: true }),
  ]);

  const hits = (hitRes.data ?? []) as HitRateRow[];
  const calib = (calibRes.data ?? []) as CalibrationRow[];
  const override = (overrideRes.data ?? null) as OverrideRow | null;
  const feedback = (feedbackRes.data ?? []) as FeedbackRow[];
  const totalSignals = signalCountRes.count ?? 0;

  const hitsByGrade = new Map(hits.map((h) => [h.signal_grade, h]));
  const rmse = calibrationRmse(calib);
  const strongBuyHit5d = hitsByGrade.get('STRONG_BUY')?.hit_rate_5d ?? null;

  // Override sanity: did override cohort actually under-perform baseline?
  const overrideHelped =
    override &&
    override.override_avg_return_10d != null &&
    override.baseline_avg_return_10d != null
      ? override.override_avg_return_10d < override.baseline_avg_return_10d
      : null;

  // Feedback rollup
  const fbWithSignal = feedback.filter((f) => f.signal_grade != null);
  const fbAvgAccuracy =
    feedback.length > 0
      ? feedback.reduce((s, f) => s + (f.accuracy_score ?? 0), 0) /
        Math.max(1, feedback.filter((f) => f.accuracy_score != null).length)
      : null;

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Target className="h-5 w-5 text-status-info" />
            신호 정확도 (Phase A — 측정 인프라)
          </h1>
          <p className="mt-1 text-sm text-txt-secondary">
            마이그레이션 30의 4개 신규 뷰로 산출. 등급별 hit rate, calibration,
            Taleb override 효과성, 사용자 피드백 ↔ 신호 정확도 연결.
          </p>
        </div>
        <Link
          href="/admin/agent-monitoring"
          className="inline-flex items-center gap-1.5 rounded-md border border-border-divider bg-surface-elevated px-3 py-1.5 text-sm text-txt-secondary transition-colors hover:bg-surface-hover hover:text-txt-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          모니터링으로
        </Link>
      </header>

      {/* Top KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <KpiCard
          icon={<ChartLine className="h-4 w-4 text-txt-primary" />}
          label="누적 신호 수"
          value={totalSignals.toLocaleString('ko-KR')}
          hint={`등급별 분포: ${hits.length}개 등급 관측됨`}
        />
        <KpiCard
          icon={<CheckCircle2 className="h-4 w-4 text-status-success" />}
          label="STRONG_BUY 5일 hit rate"
          value={pct(strongBuyHit5d)}
          hint={
            hitsByGrade.get('STRONG_BUY')?.n_5d != null
              ? `n=${hitsByGrade.get('STRONG_BUY')?.n_5d}`
              : '데이터 없음'
          }
          tone={
            strongBuyHit5d != null && strongBuyHit5d >= 0.55
              ? 'success'
              : strongBuyHit5d != null && strongBuyHit5d < 0.45
                ? 'danger'
                : 'neutral'
          }
        />
        <KpiCard
          icon={<Target className="h-4 w-4 text-status-info" />}
          label="Calibration RMSE"
          value={rmse != null ? rmse.toFixed(3) : '—'}
          hint={
            rmse != null
              ? rmse < 0.10
                ? '< 0.10 — 양호'
                : rmse < 0.20
                  ? '0.10~0.20 — 개선 필요'
                  : '≥ 0.20 — 심각'
              : 'STRONG_BUY/BUY 신호 부족'
          }
          tone={
            rmse != null && rmse < 0.10
              ? 'success'
              : rmse != null && rmse >= 0.20
                ? 'danger'
                : 'neutral'
          }
        />
        <KpiCard
          icon={<ShieldAlert className="h-4 w-4 text-status-danger" />}
          label="Taleb override 적중"
          value={
            overrideHelped == null ? '—' : overrideHelped ? '효과적' : '효과 미달'
          }
          hint={
            override && override.n_overrides > 0
              ? `n=${override.n_overrides} (override) vs ${override.n_baseline} (baseline)`
              : '데이터 없음'
          }
          tone={
            overrideHelped == null ? 'neutral' : overrideHelped ? 'success' : 'danger'
          }
        />
      </div>

      {/* Hit rate table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">등급별 Hit Rate (방향성 정확도)</CardTitle>
          <p className="text-xs text-txt-muted mt-1">
            <code>v_signal_hit_rate</code> · 1/5/10 거래일 후 종가가 신호 시점보다 높은 비율
          </p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-txt-muted border-b border-border-divider">
                <th className="px-4 py-2 font-medium">등급</th>
                <th className="px-4 py-2 font-medium text-right">1일 hit / 평균 수익</th>
                <th className="px-4 py-2 font-medium text-right">5일 hit / 평균 수익</th>
                <th className="px-4 py-2 font-medium text-right">10일 hit / 평균 수익</th>
                <th className="px-4 py-2 font-medium text-right">표본 (n)</th>
              </tr>
            </thead>
            <tbody>
              {GRADE_ORDER.map((grade) => {
                const row = hitsByGrade.get(grade);
                const band = gradeBand(grade);
                if (!row || row.n_5d === 0) {
                  return (
                    <tr key={grade} className="border-b border-border-subtle last:border-0">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px]">{grade}</Badge>
                          <span className="text-txt-secondary">{band.label}</span>
                        </div>
                      </td>
                      <td colSpan={4} className="px-4 py-2.5 text-center text-xs text-txt-muted">
                        관측 데이터 없음 (final_signals 부족 또는 forward 가격 미수집)
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={grade} className="border-b border-border-subtle last:border-0">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">{grade}</Badge>
                        <span className="text-txt-secondary">{band.label}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      <span className="font-mono">{pct(row.hit_rate_1d)}</span>
                      <span className={`ml-2 text-xs ${returnTone(row.avg_return_1d)}`}>
                        {pctSigned(row.avg_return_1d, 2)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      <span className="font-mono">{pct(row.hit_rate_5d)}</span>
                      <span className={`ml-2 text-xs ${returnTone(row.avg_return_5d)}`}>
                        {pctSigned(row.avg_return_5d, 2)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      <span className="font-mono">{pct(row.hit_rate_10d)}</span>
                      <span className={`ml-2 text-xs ${returnTone(row.avg_return_10d)}`}>
                        {pctSigned(row.avg_return_10d, 2)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-xs text-txt-muted">
                      {row.n_5d}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Calibration */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Confidence Calibration (5일 horizon)</CardTitle>
            <p className="text-xs text-txt-muted mt-1">
              STRONG_BUY/BUY 신호의 신뢰도 decile별 실제 hit rate. 점이 점선 위에 있으면
              under-confident, 아래면 over-confident.
            </p>
          </CardHeader>
          <CardContent>
            {calib.length === 0 ? (
              <p className="text-xs text-txt-muted py-12 text-center">
                STRONG_BUY/BUY 신호 + 5일 forward 가격 데이터가 누적되면 표시됩니다.
              </p>
            ) : (
              <CalibrationChart
                data={calib.map((c) => ({
                  decile_label: `${(c.decile_low * 100).toFixed(0)}-${(c.decile_high * 100).toFixed(0)}%`,
                  avg_confidence: Number(c.avg_confidence),
                  actual_hit_rate_5d: Number(c.actual_hit_rate_5d),
                  n_signals: c.n_signals,
                }))}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-status-danger" />
              Taleb override 사후 검증
            </CardTitle>
            <p className="text-xs text-txt-muted mt-1">
              <code>v_taleb_override_effectiveness</code> · 10일 forward
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {!override || override.n_overrides === 0 ? (
              <p className="text-xs text-txt-muted">
                아직 Taleb override 발생한 신호 없음. severity 4+ 발동 후 데이터 누적되면 표시됩니다.
              </p>
            ) : (
              <>
                <div className="rounded-md border border-status-danger/30 bg-status-danger/5 p-3">
                  <div className="text-[10px] text-txt-muted uppercase tracking-wider">
                    Override cohort
                  </div>
                  <div className="font-heading text-lg font-semibold mt-0.5">
                    {pctSigned(override.override_avg_return_10d)}
                  </div>
                  <div className="text-[11px] text-txt-muted mt-1">
                    n={override.n_overrides} · 5%↓ 손실률 {pct(override.override_loss_5pct_rate)}
                  </div>
                </div>
                <div className="rounded-md border border-border-subtle bg-surface-elevated p-3">
                  <div className="text-[10px] text-txt-muted uppercase tracking-wider">
                    Baseline (non-override)
                  </div>
                  <div className="font-heading text-lg font-semibold mt-0.5">
                    {pctSigned(override.baseline_avg_return_10d)}
                  </div>
                  <div className="text-[11px] text-txt-muted mt-1">
                    n={override.n_baseline} · 5%↓ 손실률 {pct(override.baseline_loss_5pct_rate)}
                  </div>
                </div>
                <div
                  className={`text-xs rounded-md px-2.5 py-2 ${
                    overrideHelped
                      ? 'bg-status-success/10 text-status-success border border-status-success/30'
                      : 'bg-status-warning/10 text-status-warning border border-status-warning/30'
                  }`}
                >
                  {overrideHelped ? (
                    <span className="inline-flex items-center gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      override cohort가 baseline 대비 더 부진 → 진짜 위험을 잡고 있음
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <XCircle className="h-3.5 w-3.5" />
                      override cohort가 baseline 대비 부진하지 않음 → false alarm 가능성
                    </span>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Calibration buckets table */}
      {calib.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Calibration bucket 상세</CardTitle>
            <p className="text-xs text-txt-muted mt-1">
              <code>v_signal_calibration</code> · STRONG_BUY/BUY only
            </p>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-txt-muted border-b border-border-divider">
                  <th className="px-4 py-2 font-medium">Confidence 구간</th>
                  <th className="px-4 py-2 font-medium text-right">평균 confidence</th>
                  <th className="px-4 py-2 font-medium text-right">실제 5일 hit</th>
                  <th className="px-4 py-2 font-medium text-right">평균 수익률</th>
                  <th className="px-4 py-2 font-medium text-right">표본 (n)</th>
                </tr>
              </thead>
              <tbody>
                {calib.map((c) => {
                  const diff = Number(c.avg_confidence) - Number(c.actual_hit_rate_5d);
                  return (
                    <tr key={c.confidence_decile} className="border-b border-border-subtle last:border-0">
                      <td className="px-4 py-2 font-mono text-xs">
                        {(c.decile_low * 100).toFixed(0)}–{(c.decile_high * 100).toFixed(0)}%
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{pct(c.avg_confidence)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {pct(c.actual_hit_rate_5d)}
                        <span
                          className={`ml-2 text-[10px] ${
                            Math.abs(diff) < 0.05
                              ? 'text-status-success'
                              : 'text-status-warning'
                          }`}
                        >
                          Δ {diff >= 0 ? '+' : ''}
                          {(diff * 100).toFixed(1)}pp
                        </span>
                      </td>
                      <td className={`px-4 py-2 text-right tabular-nums ${returnTone(c.avg_return_5d)}`}>
                        {pctSigned(c.avg_return_5d, 2)}
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-txt-muted">{c.n_signals}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* User feedback */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageSquareText className="h-4 w-4 text-txt-primary" />
            사용자 피드백 ↔ 신호 매칭 (최근 20건)
          </CardTitle>
          <p className="text-xs text-txt-muted mt-1">
            <code>v_feedback_signal_link</code> · 같은 일자 같은 종목 final_signal과 5일 forward
            return 함께 표시 · 평균 정확도 점수 {fbAvgAccuracy != null ? fbAvgAccuracy.toFixed(2) : '—'}
            /5.0
          </p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {feedback.length === 0 ? (
            <p className="text-xs text-txt-muted px-4 py-6 text-center">
              피드백 데이터가 아직 없습니다. Telegram /feedback 또는 웹에서 평점 입력 시 누적됩니다.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-txt-muted border-b border-border-divider">
                  <th className="px-4 py-2 font-medium">일자</th>
                  <th className="px-4 py-2 font-medium">종목</th>
                  <th className="px-4 py-2 font-medium text-right">정확도 점수</th>
                  <th className="px-4 py-2 font-medium text-right">유용성 점수</th>
                  <th className="px-4 py-2 font-medium">매칭 등급</th>
                  <th className="px-4 py-2 font-medium text-right">5일 수익률</th>
                </tr>
              </thead>
              <tbody>
                {feedback.map((f) => (
                  <tr key={f.feedback_id} className="border-b border-border-subtle last:border-0">
                    <td className="px-4 py-2 text-xs text-txt-secondary whitespace-nowrap">
                      {f.feedback_date}
                    </td>
                    <td className="px-4 py-2 text-xs text-txt-secondary">{f.ticker ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{f.accuracy_score ?? '—'}/5</td>
                    <td className="px-4 py-2 text-right tabular-nums">{f.usefulness_score ?? '—'}/5</td>
                    <td className="px-4 py-2">
                      {f.signal_grade ? (
                        <Badge variant="outline" className="text-[10px]">{f.signal_grade}</Badge>
                      ) : (
                        <span className="text-xs text-txt-muted">매칭 없음</span>
                      )}
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums ${returnTone(f.return_5d)}`}>
                      {pctSigned(f.return_5d, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-txt-muted">
        뷰: <code>v_signal_forward_returns</code> · <code>v_signal_hit_rate</code> ·{' '}
        <code>v_signal_calibration</code> · <code>v_taleb_override_effectiveness</code> ·{' '}
        <code>v_feedback_signal_link</code> · 마이그레이션 30.
      </p>
    </div>
  );
}

interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: 'success' | 'danger' | 'neutral';
}

function KpiCard({ icon, label, value, hint, tone = 'neutral' }: KpiCardProps) {
  const toneCls =
    tone === 'success'
      ? 'text-status-success'
      : tone === 'danger'
        ? 'text-status-danger'
        : 'text-txt-primary';
  return (
    <Card>
      <CardContent className="p-4 space-y-1">
        <div className="flex items-center gap-2 text-xs text-txt-muted uppercase tracking-wider">
          {icon}
          {label}
        </div>
        <div className={`font-heading text-2xl font-semibold tabular-nums ${toneCls}`}>
          {value}
        </div>
        {hint && <div className="text-[11px] text-txt-muted">{hint}</div>}
      </CardContent>
    </Card>
  );
}
