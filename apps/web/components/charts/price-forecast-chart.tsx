'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

import { ClientOnly } from './client-only';
import { cn } from '@/lib/utils';

/**
 * Price-based forecast chart. Y-axis is KRW (like a real stock chart),
 * and the forecast is a price projection — a random-walk-with-drift
 * cone served by /api/kr-forecast.
 *
 * This replaces the score-based "예측 점수 추이" as the primary chart on
 * the stock detail page. The score chart still exists for model
 * diagnostics, but for a user the price view is what's intuitive and
 * what they actually care about.
 *
 * Honest by construction: the forecast band widens with √h and we never
 * imply a confident direction — the cone is the message. Disclaimer is
 * pinned below per CLAUDE.md ABSOLUTE RULE A.
 */

type ForecastPeriod = '1M' | '3M' | '6M';

const PERIOD_BARS: Record<ForecastPeriod, number> = {
  '1M': 22,
  '3M': 66,
  '6M': 130,
};

const PERIODS: ForecastPeriod[] = ['1M', '3M', '6M'];

interface HistPoint {
  date: string;
  close: number;
}
interface ForecastPoint {
  date: string;
  predicted: number;
  lower: number;
  upper: number;
  horizon: number;
}
interface OvernightMeta {
  us_symbol: string;
  beta: number;
  correlation: number;
  r_squared: number;
  us_return: number;
  us_date: string;
  gap_pct: number;
}
interface ExpertMeta {
  score: number; // soros weighted_score (-2..+2)
  grade: string | null;
  tilt_daily: number;
  tilt_total_pct: number;
}
interface CalibrationMeta {
  k: number;
  band_mult: number;
  n_evaluated: number;
  direction_hit_rate: number | null;
  coverage: number | null;
  median_abs_err: number | null;
  learning: boolean;
}
interface TrackRow {
  forecast_date: string;
  target_date: string;
  base_price: number;
  predicted: number;
  lower_band: number;
  upper_band: number;
  expert_grade: string | null;
  actual: number | null;
  actual_date: string | null;
  direction_hit: boolean | null;
  within_band: boolean | null;
  abs_pct_err: number | null;
}
interface ForecastMeta {
  ok: boolean;
  reason?: string;
  last_close?: number;
  drift_daily?: number;
  vol_daily?: number;
  lookback_used?: number;
  horizon?: number;
  method?: string;
  overnight?: OvernightMeta | null;
  expert?: ExpertMeta | null;
  calibration?: CalibrationMeta;
}

// Human label for the US proxy symbols.
const US_LABEL: Record<string, string> = {
  '^SOX': '필라델피아 반도체',
  '^IXIC': '나스닥',
  '^GSPC': 'S&P 500',
  '^DJI': '다우',
  SOXX: '반도체 ETF',
  XLK: '기술주 ETF',
  XBI: '바이오 ETF',
  IBB: '바이오 ETF',
  LIT: '리튬·배터리 ETF',
  CARZ: '자동차 ETF',
};
interface ForecastResponse {
  ticker: string;
  history: HistPoint[];
  forecast: ForecastPoint[];
  track?: TrackRow[];
  meta: ForecastMeta;
}

interface ChartRow {
  date: string;
  close: number | null; // actual
  predicted: number | null; // forecast center
  band_low: number | null;
  band_delta: number | null; // upper - low, for stacked-area band
  isForecast: boolean;
  // Past-forecast audit overlay: what we predicted for THIS date 5
  // trading days earlier, plotted against what actually happened.
  evalPredicted?: number | null;
  evalHit?: boolean | null; // direction_hit of that past forecast
  evalForecastDate?: string | null;
  evalErrPct?: number | null;
}

const fmtKRW = (v: number | null) =>
  v == null ? '—' : `${Math.round(v).toLocaleString('ko-KR')}원`;

export function PriceForecastChart({
  ticker,
  initialPeriod = '3M',
}: {
  ticker: string;
  initialPeriod?: ForecastPeriod;
}) {
  const [period, setPeriod] = useState<ForecastPeriod>(initialPeriod);
  const [resp, setResp] = useState<ForecastResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setErrored(false);
    // Always request the largest window + 5-day horizon; slice client-side.
    fetch(`/api/kr-forecast?ticker=${ticker}&horizon=5&lookback=40`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: ForecastResponse) => {
        if (cancelled) return;
        setResp(j);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setErrored(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  const { rows, yDomain, lastClose, meta } = useMemo(() => {
    if (!resp || !resp.history || resp.history.length === 0) {
      return {
        rows: [] as ChartRow[],
        yDomain: [0, 1] as [number, number],
        lastClose: null as number | null,
        meta: resp?.meta ?? null,
      };
    }
    const bars = PERIOD_BARS[period];
    const hist = resp.history.slice(-bars);
    const last = hist[hist.length - 1];

    const histRows: ChartRow[] = hist.map((h, i) => ({
      date: h.date,
      close: h.close,
      // Seed the forecast series at the last actual point so the dashed
      // line + band connect seamlessly instead of floating.
      predicted: i === hist.length - 1 ? h.close : null,
      band_low: i === hist.length - 1 ? h.close : null,
      band_delta: i === hist.length - 1 ? 0 : null,
      isForecast: false,
    }));

    const fcRows: ChartRow[] = (resp.forecast ?? []).map((f) => ({
      date: f.date,
      close: null,
      predicted: f.predicted,
      band_low: f.lower,
      band_delta: f.upper - f.lower,
      isForecast: true,
    }));

    const all = [...histRows, ...fcRows];

    // Overlay: evaluated past forecasts pinned at their realized dates.
    // This is the audit view — each dot is "5거래일 전 예측" vs the line
    // (actual). Hit/miss colors come from direction_hit.
    const byDate = new Map(all.map((r) => [r.date, r]));
    for (const t of resp.track ?? []) {
      if (t.actual == null) continue;
      const key = t.actual_date ?? t.target_date;
      const row = byDate.get(key);
      if (!row) continue; // outside the visible window
      row.evalPredicted = t.predicted;
      row.evalHit = t.direction_hit;
      row.evalForecastDate = t.forecast_date;
      row.evalErrPct = t.abs_pct_err != null ? t.abs_pct_err * 100 : null;
    }

    // Y domain across visible closes + forecast bands, padded 3%.
    const vals: number[] = [];
    for (const h of hist) vals.push(h.close);
    for (const f of resp.forecast ?? []) {
      vals.push(f.lower, f.upper);
    }
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = (hi - lo) * 0.03 || hi * 0.02;
    return {
      rows: all,
      yDomain: [Math.max(0, Math.floor((lo - pad) / 100) * 100), Math.ceil((hi + pad) / 100) * 100] as [
        number,
        number,
      ],
      lastClose: last.close,
      meta: resp.meta,
    };
  }, [resp, period]);

  const forecast = resp?.forecast ?? [];
  const fc5 = forecast.length > 0 ? forecast[forecast.length - 1] : null;
  const volPct = meta?.vol_daily != null ? meta.vol_daily * 100 : null;
  // Expected 5-day move range as % of last close.
  const rangePct =
    fc5 && lastClose
      ? {
          low: ((fc5.lower - lastClose) / lastClose) * 100,
          high: ((fc5.upper - lastClose) / lastClose) * 100,
          mid: ((fc5.predicted - lastClose) / lastClose) * 100,
        }
      : null;

  return (
    <div className="w-full">
      {/* Header — period selector + readout */}
      <div className="mb-3 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex rounded-md bg-bg-secondary/40 p-0.5 border border-border-subtle/40">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={cn(
                'px-2.5 py-1 text-[11px] font-semibold transition-all rounded',
                period === p
                  ? 'bg-brand-purple text-white shadow-sm'
                  : 'text-txt-secondary hover:text-txt-primary',
              )}
            >
              {p}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-[12px]">
          {lastClose != null && (
            <span>
              <span className="text-txt-muted mr-1">현재가</span>
              <b className="tabular-nums">{fmtKRW(lastClose)}</b>
            </span>
          )}
          {volPct != null && (
            <span title="최근 40거래일 일간 로그수익률 표준편차 (연율화 아님)">
              <span className="text-txt-muted mr-1">일변동성</span>
              <b className="tabular-nums">{volPct.toFixed(1)}%</b>
            </span>
          )}
        </div>
      </div>

      {/* Overnight US lead-signal readout — the "미국 마감 → 한국 시작" edge. */}
      {meta?.overnight && (
        <div className="mb-2 flex items-center gap-2 flex-wrap text-[12px]">
          <span className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 bg-status-info/10 border border-status-info/30">
            🌙 어젯밤{' '}
            <b>{US_LABEL[meta.overnight.us_symbol] ?? meta.overnight.us_symbol}</b>{' '}
            <span
              className={cn(
                'tabular-nums font-semibold',
                meta.overnight.us_return >= 0 ? 'text-status-success' : 'text-status-error',
              )}
            >
              {meta.overnight.us_return >= 0 ? '+' : ''}
              {(meta.overnight.us_return * 100).toFixed(2)}%
            </span>
          </span>
          <span className="text-txt-muted">→ 시가 갭 추정</span>
          <span
            className={cn(
              'tabular-nums font-semibold',
              meta.overnight.gap_pct >= 0 ? 'text-status-success' : 'text-status-error',
            )}
          >
            {meta.overnight.gap_pct >= 0 ? '+' : ''}
            {meta.overnight.gap_pct.toFixed(2)}%
          </span>
          <span
            className="text-txt-muted text-[11px]"
            title={`전일 ${meta.overnight.us_symbol} 변동에 대한 회귀 베타 ${meta.overnight.beta.toFixed(2)}, 상관 ρ=${meta.overnight.correlation.toFixed(2)} (R²=${meta.overnight.r_squared.toFixed(2)}). 이 종목 시가는 어젯밤 미국장 움직임과 통계적으로 연동됩니다.`}
          >
            (연동도 ρ={meta.overnight.correlation.toFixed(2)})
          </span>
        </div>
      )}

      {/* AI-expert consensus tilt — the experts' call, made auditable. */}
      {meta?.expert && (
        <div className="mb-2 flex items-center gap-2 flex-wrap text-[12px]">
          <span className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 bg-brand-purple/10 border border-brand-purple/30">
            🧠 전문가 합의{' '}
            <b>{meta.expert.grade ?? '—'}</b>{' '}
            <span className="tabular-nums text-txt-secondary">
              ({meta.expert.score >= 0 ? '+' : ''}
              {meta.expert.score.toFixed(2)})
            </span>
          </span>
          <span className="text-txt-muted">→ 예측 기울기</span>
          <span
            className={cn(
              'tabular-nums font-semibold',
              meta.expert.tilt_total_pct >= 0 ? 'text-status-success' : 'text-status-error',
            )}
          >
            {meta.expert.tilt_total_pct >= 0 ? '+' : ''}
            {meta.expert.tilt_total_pct.toFixed(2)}%
          </span>
          {meta.calibration && (
            <span
              className="text-txt-muted text-[11px]"
              title={
                meta.calibration.learning
                  ? `반영 강도 k=${meta.calibration.k.toFixed(2)} — 평가된 예측 ${meta.calibration.n_evaluated}건에서 '전문가 점수 ↔ 실현 수익률' 상관으로 학습된 값. 전문가 판단이 맞을수록 k가 커지고, 틀리면 0으로 줄어듭니다.`
                  : `반영 강도 k=${meta.calibration.k.toFixed(2)} (초기값) — 평가된 예측이 20건 쌓이면 실적 기반으로 자동 학습됩니다. 현재 ${meta.calibration.n_evaluated}건.`
              }
            >
              (반영강도 k={meta.calibration.k.toFixed(2)}
              {meta.calibration.learning ? ' · 학습됨' : ' · 초기값'})
            </span>
          )}
        </div>
      )}

      {/* 5-day forecast summary */}
      {rangePct && fc5 && (
        <div className="mb-2 flex items-center gap-2 flex-wrap text-[12px]">
          <span className="text-txt-muted">5거래일 예측 범위</span>
          <span className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 bg-brand-purple/10 border border-brand-purple/30 tabular-nums">
            {fmtKRW(fc5.lower)} ~ {fmtKRW(fc5.upper)}
          </span>
          <span
            className={cn(
              'tabular-nums font-semibold',
              rangePct.mid >= 0 ? 'text-status-success' : 'text-status-error',
            )}
          >
            중앙값 {rangePct.mid >= 0 ? '+' : ''}
            {rangePct.mid.toFixed(1)}%
          </span>
          <span className="text-txt-muted text-[11px]">
            (−{Math.abs(rangePct.low).toFixed(1)}% ~ +{rangePct.high.toFixed(1)}%)
          </span>
        </div>
      )}

      {/* Chart */}
      <div className="h-64 w-full">
        <ClientOnly fallback={<div className="h-full w-full animate-pulse rounded bg-bg-secondary/30" />}>
          {loading ? (
            <div className="flex h-full items-center justify-center text-[12px] text-txt-muted">
              가격 데이터 불러오는 중…
            </div>
          ) : errored || !meta?.ok || rows.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[12px] text-txt-muted text-center px-4">
              {meta?.reason === 'insufficient_history' || meta?.reason === 'insufficient_returns'
                ? '예측에 필요한 가격 이력이 부족합니다.'
                : '가격 예측을 불러오지 못했습니다.'}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 8 }}>
                <defs>
                  <linearGradient id="priceForecastBand" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#FF902F" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="#FF902F" stopOpacity={0.06} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: 'var(--text-secondary)', fontSize: 10 }}
                  tickFormatter={(v: string) => v.slice(5)}
                  minTickGap={24}
                />
                <YAxis
                  domain={yDomain}
                  tick={{ fill: 'var(--text-secondary)', fontSize: 10 }}
                  width={56}
                  tickFormatter={(v: number) => (v >= 10000 ? `${(v / 1000).toFixed(0)}k` : `${v}`)}
                  allowDecimals={false}
                />
                <Tooltip
                  cursor={{
                    stroke: 'rgb(114,60,235)',
                    strokeWidth: 1.4,
                    strokeOpacity: 0.85,
                    strokeDasharray: '4 3',
                  }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const row = payload[0]?.payload as ChartRow | undefined;
                    if (!row) return null;
                    return (
                      <div
                        style={{
                          background: 'var(--bg-secondary)',
                          border: '1px solid var(--border-default)',
                          borderRadius: 8,
                          fontSize: 12,
                          padding: '8px 10px',
                          minWidth: 150,
                        }}
                      >
                        <div style={{ marginBottom: 4, color: 'var(--text-secondary)' }}>
                          {label}
                          {row.isForecast && (
                            <span style={{ marginLeft: 6, color: '#FF902F' }}>예측</span>
                          )}
                        </div>
                        {row.close != null && (
                          <div>
                            종가: <b>{fmtKRW(row.close)}</b>
                          </div>
                        )}
                        {row.isForecast && row.predicted != null && (
                          <>
                            <div>
                              예측 중앙값: <b>{fmtKRW(row.predicted)}</b>
                            </div>
                            {row.band_low != null && row.band_delta != null && (
                              <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>
                                95% 구간: {fmtKRW(row.band_low)} ~{' '}
                                {fmtKRW(row.band_low + row.band_delta)}
                              </div>
                            )}
                          </>
                        )}
                        {row.evalPredicted != null && (
                          <div
                            style={{
                              marginTop: 4,
                              paddingTop: 4,
                              borderTop: '1px solid var(--border-default)',
                            }}
                          >
                            <div>
                              {row.evalForecastDate?.slice(5)} 예측치:{' '}
                              <b>{fmtKRW(row.evalPredicted)}</b>
                            </div>
                            <div
                              style={{
                                color:
                                  row.evalHit == null
                                    ? 'var(--text-secondary)'
                                    : row.evalHit
                                      ? '#22A06B'
                                      : '#E5484D',
                              }}
                            >
                              방향 {row.evalHit == null ? '—' : row.evalHit ? '적중 ✓' : '빗나감 ✗'}
                              {row.evalErrPct != null && ` · 오차 ${row.evalErrPct.toFixed(1)}%`}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  }}
                />

                {/* Confidence band — stacked-area trick: invisible base at
                    band_low, gradient delta on top. */}
                <Area
                  type="monotone"
                  dataKey="band_low"
                  stackId="band"
                  stroke="none"
                  fill="transparent"
                  isAnimationActive={false}
                  connectNulls={false}
                  activeDot={false}
                />
                <Area
                  type="monotone"
                  dataKey="band_delta"
                  stackId="band"
                  stroke="none"
                  fill="url(#priceForecastBand)"
                  fillOpacity={1}
                  isAnimationActive={false}
                  connectNulls={false}
                  activeDot={false}
                />

                {/* Current-price reference */}
                {lastClose != null && (
                  <ReferenceLine
                    y={lastClose}
                    stroke="rgba(114,60,235,0.35)"
                    strokeDasharray="4 4"
                  />
                )}

                {/* Actual close — solid purple */}
                <Line
                  type="monotone"
                  dataKey="close"
                  stroke="#723CEB"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 3 }}
                  connectNulls={false}
                  isAnimationActive={false}
                  name="종가"
                />
                {/* Forecast center — dashed orange */}
                <Line
                  type="monotone"
                  dataKey="predicted"
                  stroke="#FF902F"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  dot={{ r: 2.5, fill: '#FF902F' }}
                  activeDot={{ r: 4 }}
                  connectNulls
                  isAnimationActive={false}
                  name="예측"
                />
                {/* Past-forecast audit dots — what we predicted for each
                    date, plotted against the actual line. Green = 방향
                    적중, red = 빗나감. This is the accuracy feedback the
                    section exists for. */}
                <Line
                  dataKey="evalPredicted"
                  stroke="none"
                  isAnimationActive={false}
                  connectNulls={false}
                  name="과거 예측"
                  legendType="none"
                  dot={(props: { cx?: number; cy?: number; payload?: ChartRow }) => {
                    const { cx, cy, payload } = props;
                    if (cx == null || cy == null || payload?.evalPredicted == null) {
                      return <g key={`ev-${payload?.date ?? Math.random()}`} />;
                    }
                    const hit = payload.evalHit;
                    const color = hit == null ? '#9CA3AF' : hit ? '#22A06B' : '#E5484D';
                    return (
                      <g key={`ev-${payload.date}`}>
                        <circle cx={cx} cy={cy} r={3.5} fill={color} fillOpacity={0.9} stroke="var(--bg-primary, #fff)" strokeWidth={1} />
                      </g>
                    );
                  }}
                  activeDot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </ClientOnly>
      </div>

      {/* Accuracy scorecard — the audit readout this section exists for.
          Numbers come from the immutable forecast ledger and improve as
          evaluated rows accumulate. */}
      {meta?.calibration && (
        <div className="mt-3 rounded-md border border-border-subtle/60 bg-bg-secondary/30 px-3 py-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-[11px] font-semibold text-txt-secondary">
              📋 예측 검증 기록부
              <span className="ml-1.5 font-normal text-txt-muted">
                매일 예측을 기록하고 5거래일 뒤 실측과 자동 대조
              </span>
            </span>
            <span className="text-[10px] text-txt-muted">
              평가 완료 {meta.calibration.n_evaluated}건
              {meta.calibration.learning ? ' · 보정 학습 작동 중' : ` · ${Math.max(0, 20 - meta.calibration.n_evaluated)}건 더 쌓이면 자동 학습 시작`}
            </span>
          </div>
          {meta.calibration.n_evaluated > 0 ? (
            <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[12px]">
              <div title="예측 방향(상승/하락)이 실제와 일치한 비율 — 50%가 동전 던지기 기준선">
                <div className="text-[10px] text-txt-muted">방향 적중률</div>
                <b className="tabular-nums">
                  {meta.calibration.direction_hit_rate != null
                    ? `${(meta.calibration.direction_hit_rate * 100).toFixed(0)}%`
                    : '—'}
                </b>
              </div>
              <div title="실측 종가가 95% 예측 구간 안에 들어온 비율 — 95%에 가까울수록 구간 폭이 정직함">
                <div className="text-[10px] text-txt-muted">95% 구간 적중</div>
                <b className="tabular-nums">
                  {meta.calibration.coverage != null
                    ? `${(meta.calibration.coverage * 100).toFixed(0)}%`
                    : '—'}
                </b>
              </div>
              <div title="예측 중앙값과 실측 종가의 절대 오차 중앙값">
                <div className="text-[10px] text-txt-muted">중앙값 오차</div>
                <b className="tabular-nums">
                  {meta.calibration.median_abs_err != null
                    ? `${(meta.calibration.median_abs_err * 100).toFixed(1)}%`
                    : '—'}
                </b>
              </div>
              <div title="전문가 합의가 예측 기울기에 반영되는 강도. 평가 20건부터 '전문가 점수 ↔ 실현 수익률' 상관으로 자동 학습 — 전문가가 맞을수록 커지고 틀리면 0으로 수렴">
                <div className="text-[10px] text-txt-muted">전문가 반영강도 k</div>
                <b className="tabular-nums">
                  {meta.calibration.k.toFixed(2)}
                  <span className="ml-1 text-[10px] font-normal text-txt-muted">
                    {meta.calibration.learning ? '학습됨' : '초기값'}
                  </span>
                </b>
              </div>
            </div>
          ) : (
            <p className="mt-1 text-[11px] text-txt-muted">
              아직 평가된 예측이 없습니다. 오늘부터 매일 예측이 기록되고, 5거래일 뒤부터 적중률이 여기에
              누적됩니다 — 기록이 쌓일수록 전문가 반영 강도와 구간 폭이 데이터로 보정됩니다.
            </p>
          )}
        </div>
      )}

      {/* Legend + disclaimer */}
      <div className="mt-2 flex items-center gap-4 text-[11px] text-txt-muted flex-wrap">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 bg-brand-purple" /> 실제 종가
        </span>
        <span className="inline-flex items-center gap-1">
          <span
            className="inline-block h-0.5 w-4"
            style={{ background: '#FF902F', borderTop: '2px dashed #FF902F' }}
          />{' '}
          예측 ({meta?.expert ? '전문가신호+야간신호+랜덤워크' : meta?.overnight ? '야간신호+랜덤워크' : '랜덤워크+드리프트'})
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: 'rgba(255,144,47,0.18)' }} /> 95% 구간
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: '#22A06B' }} /> 과거 예측 적중
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: '#E5484D' }} /> 빗나감
        </span>
      </div>
      <p className="mt-1.5 text-[10px] text-txt-muted leading-relaxed">
        예측은 최근 가격 변동성 기반 통계적 추정 범위이며, 방향을 단정하지 않습니다. 본 정보는 투자 판단
        보조 자료이며 매매 권유가 아닙니다.
      </p>
    </div>
  );
}
