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
  meta: ForecastMeta;
}

interface ChartRow {
  date: string;
  close: number | null; // actual
  predicted: number | null; // forecast center
  band_low: number | null;
  band_delta: number | null; // upper - low, for stacked-area band
  isForecast: boolean;
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
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </ClientOnly>
      </div>

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
          예측 ({meta?.overnight ? '야간신호+랜덤워크' : '랜덤워크+드리프트'})
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: 'rgba(255,144,47,0.18)' }} /> 95% 구간
        </span>
      </div>
      <p className="mt-1.5 text-[10px] text-txt-muted leading-relaxed">
        예측은 최근 가격 변동성 기반 통계적 추정 범위이며, 방향을 단정하지 않습니다. 본 정보는 투자 판단
        보조 자료이며 매매 권유가 아닙니다.
      </p>
    </div>
  );
}
