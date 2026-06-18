import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { createAdminClient } from '@/lib/supabase/admin';
import { PaperEquityChart } from '@/components/paper/equity-chart';
import { PaperSettings } from '@/components/paper/settings';
import { TradeDetailButton } from '@/components/paper/trade-detail';
import { PolicyCard } from '@/components/paper/policy-card';

export const dynamic = 'force-dynamic';

/**
 * Soros 모의투자 — the live usability audit.
 *
 * A global virtual portfolio (default 1억원) that the Soros consensus
 * trades automatically after every analysis cycle. This page is the
 * cockpit: equity curve, open positions with live P&L, full trade
 * ledger, and the weekly-Telegram cadence — all to answer one question:
 * "이 서비스의 신호로 실제 투자가 가능한가?"
 */

interface ConfigRow {
  initial_capital: number;
  cash: number;
  max_positions: number;
  started_at: string;
}
interface PositionRow {
  ticker: string;
  qty: number;
  avg_price: number;
  opened_at: string;
}
interface TradeRow {
  id: number;
  trade_date: string;
  ticker: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  amount: number;
  fee: number;
  tax: number;
  signal_grade: string | null;
  reason: string | null;
  realized_pnl: number | null;
}
interface OrderRow {
  id: number;
  order_date: string;
  ticker: string;
  side: 'buy' | 'sell';
  budget: number | null;
  qty: number | null;
  signal_grade: string | null;
  weighted_score: number | null;
  reason: string | null;
}
interface SnapshotRow {
  snap_date: string;
  total_value: number;
  cash: number;
  invested: number;
  unrealized_pnl: number;
  realized_pnl_cum: number;
  ret_pct: number;
  n_positions: number;
}

const krw = (v: number) => `${Math.round(v).toLocaleString('ko-KR')}원`;
const signed = (v: number) => `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString('ko-KR')}원`;

const GRADE_LABEL: Record<string, string> = {
  STRONG_BUY: '강한 관심',
  BUY: '관심',
  HOLD: '관망',
  CAUTION: '주의',
  RISK: '위험',
};

export default async function PaperPage() {
  const sb = createAdminClient();

  const [cfgRes, posRes, tradeRes, snapRes, orderRes] = await Promise.all([
    sb.from('paper_config').select('*').eq('id', 1),
    sb.from('paper_bot_positions').select('*'),
    sb.from('paper_bot_trades').select('*').order('trade_date', { ascending: false }).order('id', { ascending: false }).limit(60),
    sb.from('paper_bot_snapshots').select('*').order('snap_date').limit(400),
    sb.from('paper_bot_orders').select('*').eq('status', 'pending').order('id'),
  ]);

  // NEVER fall back to fake defaults on a query error. A transient DB
  // hiccup once rendered this page as "현금 1억 / 보유 0종목" — i.e. a
  // freshly-reset portfolio — which is far worse than an error screen:
  // it misreports the audit. Throw so the Next error boundary shows and
  // a refresh recovers.
  const failed = [
    ['paper_config', cfgRes.error],
    ['paper_bot_positions', posRes.error],
    ['paper_bot_trades', tradeRes.error],
    ['paper_bot_snapshots', snapRes.error],
    ['paper_bot_orders', orderRes.error],
  ].filter(([, e]) => e);
  if (failed.length > 0) {
    const detail = failed
      .map(([t, e]) => `${t}: ${(e as { message?: string })?.message ?? 'unknown'}`)
      .join(' · ');
    throw new Error(`모의투자 데이터 조회 실패 — 새로고침해 주세요 (${detail})`);
  }

  const { data: kospiRows } = await sb
    .from('global_market')
    .select('date, close')
    .eq('symbol', '^KS11')
    .not('close', 'is', null)
    .order('date');
  const kospi = (kospiRows ?? []) as { date: string; close: number }[];

  // Learned trading policy (executor.policy_learner) — newest first.
  const { data: policyRows } = await sb
    .from('paper_policy_state')
    .select('version, params, notes, n_episodes, created_at')
    .order('version', { ascending: false })
    .limit(20);
  const policyVersions = (policyRows ?? []) as Parameters<typeof PolicyCard>[0]['versions'];

  const cfg = (cfgRes.data?.[0] as ConfigRow | undefined) ?? {
    initial_capital: 100_000_000,
    cash: 100_000_000,
    max_positions: 10,
    started_at: new Date().toISOString(),
  };
  const positions = (posRes.data ?? []) as PositionRow[];
  const trades = (tradeRes.data ?? []) as TradeRow[];
  const snapshots = (snapRes.data ?? []) as SnapshotRow[];
  const pendingOrders = (orderRes.data ?? []) as OrderRow[];

  // Names + latest closes for live valuation.
  const tickers = Array.from(
    new Set([
      ...positions.map((p) => p.ticker),
      ...trades.map((t) => t.ticker),
      ...pendingOrders.map((o) => o.ticker),
    ]),
  );
  const names = new Map<string, string>();
  const closes = new Map<string, number>();
  if (tickers.length > 0) {
    const [{ data: stockRows }, { data: quoteRows }] = await Promise.all([
      sb.from('stocks').select('ticker, name').in('ticker', tickers),
      sb
        .from('korea_market')
        .select('ticker, date, close')
        .in('ticker', tickers)
        .not('close', 'is', null)
        .order('date', { ascending: false })
        .limit(tickers.length * 6),
    ]);
    for (const r of stockRows ?? []) names.set(r.ticker, r.name ?? r.ticker);
    for (const r of quoteRows ?? []) {
      if (!closes.has(r.ticker)) closes.set(r.ticker, Number(r.close));
    }

    // The paper bot can trade tickers outside the curated watchlist
    // (newly-listed ETFs, off-universe stocks).  Those don't have a row
    // in `stocks`, so the table falls back to the raw 6-digit code —
    // that's what the user just complained about ("464080" instead of
    // a company name).  For those, ask NAVER for the friendly Korean
    // name and merge into the lookup.  Cached for a day; names don't
    // change.
    const unresolved = tickers.filter((t) => {
      const n = names.get(t);
      return !n || n === t;
    });
    if (unresolved.length > 0) {
      const resolved = await Promise.all(
        unresolved.map(async (t) => {
          try {
            const res = await fetch(
              `https://m.stock.naver.com/api/stock/${t}/integration`,
              {
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                  Accept: 'application/json',
                },
                next: { revalidate: 86400 },
              },
            );
            if (!res.ok) return null;
            const j = (await res.json()) as { stockName?: string };
            return j.stockName ? { ticker: t, name: j.stockName } : null;
          } catch {
            return null;
          }
        }),
      );
      for (const r of resolved) {
        if (r) names.set(r.ticker, r.name);
      }
    }
  }

  // Valuation
  let invested = 0;
  let unrealized = 0;
  const enriched = positions
    .map((p) => {
      const close = closes.get(p.ticker) ?? p.avg_price;
      const value = p.qty * close;
      const pnl = p.qty * (close - p.avg_price);
      invested += value;
      unrealized += pnl;
      return {
        ...p,
        name: names.get(p.ticker) ?? p.ticker,
        close,
        value,
        pnl,
        pnlPct: ((close - p.avg_price) / p.avg_price) * 100,
      };
    })
    .sort((a, b) => b.value - a.value);

  const reserved = pendingOrders
    .filter((o) => o.side === 'buy')
    .reduce((acc, o) => acc + (o.budget ?? 0), 0);

  const realizedCum = trades
    .filter((t) => t.side === 'sell')
    .reduce((acc, t) => acc + (t.realized_pnl ?? 0), 0);
  const total = cfg.cash + reserved + invested;
  const totalPnl = total - cfg.initial_capital;
  const totalPct = (totalPnl / cfg.initial_capital) * 100;

  const last = snapshots[snapshots.length - 1];
  const weekAgoIso = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const weekBase = snapshots.find((s) => s.snap_date >= weekAgoIso);
  const weekDelta = last && weekBase ? last.total_value - weekBase.total_value : null;

  // ── Benchmark (KOSPI since portfolio start) + 월 목표 게이지 ──
  const startIso = cfg.started_at.slice(0, 10);
  const kStart = kospi.find((k) => k.date >= startIso)?.close ?? null;
  const kLatest = kospi.length > 0 ? kospi[kospi.length - 1].close : null;
  const kospiRet = kStart && kLatest ? ((kLatest - kStart) / kStart) * 100 : null;
  const alpha = kospiRet != null ? totalPct - kospiRet : null;
  // Regime: KOSPI vs its level ~3 months ago (mirrors the bot's gate).
  const cutoff = new Date(Date.now() - 92 * 86400_000).toISOString().slice(0, 10);
  const kPastArr = kospi.filter((k) => k.date <= cutoff);
  const kPast = kPastArr.length > 0 ? kPastArr[kPastArr.length - 1].close : null;
  const riskOn = kPast == null || kLatest == null ? true : kLatest >= kPast;
  // Month-to-date return vs the 5% stretch target.
  const monthStart = (last?.snap_date ?? new Date().toISOString().slice(0, 10)).slice(0, 7) + '-01';
  const mBase = snapshots.find((s) => s.snap_date >= monthStart);
  const mtdPct =
    last && mBase && mBase.total_value > 0
      ? ((last.total_value - mBase.total_value) / mBase.total_value) * 100
      : null;
  const gaugePct = mtdPct != null ? Math.min(100, Math.max(0, (mtdPct / 5) * 100)) : 0;

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Soros 모의투자</h1>
          <p className="mt-1 text-sm text-txt-secondary">
            AI 전문가 합의가 가상 자금 {krw(cfg.initial_capital)}을 자동 운용 — 신호의 실전 활용
            가능성을 실측으로 검증합니다. 매 분석 사이클 직후 매매, 매주 토요일 09:00 텔레그램 보고.
          </p>
        </div>
        <PaperSettings currentCapital={cfg.initial_capital} startedAt={cfg.started_at} />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] text-txt-muted">총자산</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums">{krw(total)}</div>
            <div
              className={`text-[12px] tabular-nums font-medium ${totalPnl >= 0 ? 'text-status-success' : 'text-status-error'}`}
            >
              {signed(totalPnl)} ({totalPct >= 0 ? '+' : ''}
              {totalPct.toFixed(2)}%)
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] text-txt-muted">주간 손익</div>
            <div
              className={`mt-0.5 text-lg font-semibold tabular-nums ${weekDelta != null && weekDelta < 0 ? 'text-status-error' : 'text-status-success'}`}
            >
              {weekDelta != null ? signed(weekDelta) : '—'}
            </div>
            <div className="text-[12px] text-txt-muted">최근 7일 (스냅샷 기준)</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] text-txt-muted">투자 / 현금</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums">{krw(invested)}</div>
            <div className="text-[12px] text-txt-muted tabular-nums">
              현금 {krw(cfg.cash + reserved)}
              {reserved > 0 ? ` (주문 예약 ${krw(reserved)})` : ''}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] text-txt-muted">손익 구성</div>
            <div
              className={`mt-0.5 text-lg font-semibold tabular-nums ${unrealized >= 0 ? 'text-status-success' : 'text-status-error'}`}
            >
              평가 {signed(unrealized)}
            </div>
            <div
              className={`text-[12px] tabular-nums ${realizedCum >= 0 ? 'text-status-success' : 'text-status-error'}`}
            >
              실현 {signed(realizedCum)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 목표 게이지 + 벤치마크 — the strategy's honest scoreboard */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-5 flex-wrap text-[13px]">
              <span title="이번 달 수익률의 월 5% 스트레치 목표(T3) 대비 진행률. 매월 1일 리셋.">
                <span className="text-txt-muted mr-1.5">이달 수익률</span>
                <b className={`tabular-nums ${mtdPct != null && mtdPct < 0 ? 'text-status-error' : 'text-status-success'}`}>
                  {mtdPct != null ? `${mtdPct >= 0 ? '+' : ''}${mtdPct.toFixed(2)}%` : '—'}
                </b>
                <span className="text-txt-muted text-[11px] ml-1">/ 목표 5%</span>
              </span>
              <span title="포트폴리오 시작일부터 코스피 대비 초과수익. 종목선별력(T1 목표 +1%p/월)의 직접 증거.">
                <span className="text-txt-muted mr-1.5">vs KOSPI</span>
                <b className={`tabular-nums ${alpha != null && alpha < 0 ? 'text-status-error' : 'text-status-success'}`}>
                  {alpha != null ? `알파 ${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}%p` : '—'}
                </b>
                {kospiRet != null && (
                  <span className="text-txt-muted text-[11px] ml-1">
                    (KOSPI {kospiRet >= 0 ? '+' : ''}
                    {kospiRet.toFixed(2)}%)
                  </span>
                )}
              </span>
              <span title="코스피가 3개월 전 수준 아래로 깨지면 신규 매수를 멈추는 안전장치. 보유·매도는 계속 작동.">
                <span className="text-txt-muted mr-1.5">레짐</span>
                <b className={riskOn ? 'text-status-success' : 'text-status-warning'}>
                  {riskOn ? 'ON · 정상 매수' : 'OFF · 신규매수 중단'}
                </b>
              </span>
            </div>
          </div>
          <div className="mt-2.5 h-2 w-full rounded-full bg-bg-secondary/60 overflow-hidden" title="월 5% 목표 게이지">
            <div
              className={`h-full rounded-full transition-all ${mtdPct != null && mtdPct < 0 ? 'bg-status-error/60' : 'bg-status-success'}`}
              style={{ width: `${gaugePct}%` }}
            />
          </div>
          <p className="mt-1.5 text-[10px] text-txt-muted">
            목표 체계: T1 코스피+1%p/월 알파 (종목선별 입증) → T2 월 +3% → T3 월 +5%. 매월 1일
            월간 평가가 텔레그램으로 발송되며, 알파가 음수면 전략 재검토 경보가 울립니다.
          </p>
        </CardContent>
      </Card>

      {/* Soros 정책 진화 카드 — how the bot is getting smarter */}
      <PolicyCard versions={policyVersions} />

      {/* Equity curve */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-heading">자산 추이</CardTitle>
        </CardHeader>
        <CardContent>
          <PaperEquityChart
            snapshots={snapshots.map((s) => ({
              date: s.snap_date,
              total: s.total_value,
              ret: s.ret_pct,
            }))}
            initialCapital={cfg.initial_capital}
          />
        </CardContent>
      </Card>

      {/* Pending orders — next-open fills */}
      {pendingOrders.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-heading">
              체결 대기 주문{' '}
              <span className="text-txt-muted font-normal text-sm">
                ({pendingOrders.length}건 · 신호일 시가 체결)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-txt-muted border-b border-border-subtle">
                    <th className="text-left py-2 pr-3 font-medium">주문일</th>
                    <th className="text-left py-2 px-3 font-medium">구분</th>
                    <th className="text-left py-2 px-3 font-medium">종목</th>
                    <th className="text-right py-2 px-3 font-medium">예산/수량</th>
                    <th className="text-left py-2 pl-3 font-medium">사유</th>
                    <th className="w-8 py-2" aria-label="상세" />
                  </tr>
                </thead>
                <tbody>
                  {pendingOrders.map((o) => (
                    <tr key={o.id} className="border-b border-border-subtle/40 last:border-0">
                      <td className="py-2 pr-3 tabular-nums text-txt-secondary">{o.order_date.slice(5)}</td>
                      <td className="py-2 px-3">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                            o.side === 'buy'
                              ? 'bg-status-success/10 text-status-success'
                              : 'bg-status-error/10 text-status-error'
                          }`}
                        >
                          {o.side === 'buy' ? '매수' : '매도'} 대기
                        </span>
                      </td>
                      <td className="py-2 px-3 font-medium">{names.get(o.ticker) ?? o.ticker}</td>
                      <td className="text-right py-2 px-3 tabular-nums">
                        {o.side === 'buy' ? krw(o.budget ?? 0) : `${(o.qty ?? 0).toLocaleString()}주`}
                      </td>
                      <td className="py-2 pl-3 text-[12px] text-txt-secondary">{o.reason ?? ''}</td>
                      <td className="py-2 pl-1">
                        <TradeDetailButton
                          data={{
                            kind: 'order',
                            name: names.get(o.ticker) ?? o.ticker,
                            ticker: o.ticker,
                            side: o.side,
                            date: o.order_date,
                            qty: o.qty,
                            budget: o.budget,
                            signal_grade: o.signal_grade,
                            weighted_score: o.weighted_score,
                            reason: o.reason,
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[10px] text-txt-muted">
              06:00 신호 → 당일 09:00 시가 체결. 시가 데이터는 다음 영업일 새벽 수집되므로 체결
              확정은 다음 사이클에 표시됩니다.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Positions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-heading">
            보유 종목 <span className="text-txt-muted font-normal text-sm">({enriched.length} / {cfg.max_positions})</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {enriched.length === 0 ? (
            <p className="text-sm text-txt-muted py-4">
              아직 보유 종목이 없습니다. 다음 분석 사이클에서 강한 신호가 나오면 자동 매수됩니다.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-txt-muted border-b border-border-subtle">
                    <th className="text-left py-2 pr-3 font-medium">종목</th>
                    <th className="text-right py-2 px-3 font-medium">수량</th>
                    <th className="text-right py-2 px-3 font-medium">평단가</th>
                    <th className="text-right py-2 px-3 font-medium">현재가</th>
                    <th className="text-right py-2 px-3 font-medium">평가금액</th>
                    <th className="text-right py-2 pl-3 font-medium">평가손익</th>
                  </tr>
                </thead>
                <tbody>
                  {enriched.map((p) => (
                    <tr key={p.ticker} className="border-b border-border-subtle/40 last:border-0">
                      <td className="py-2 pr-3">
                        <span className="font-medium">{p.name}</span>
                        <span className="ml-1.5 text-[10px] text-txt-muted">{p.opened_at.slice(5)} 진입</span>
                      </td>
                      <td className="text-right py-2 px-3 tabular-nums">{p.qty.toLocaleString()}주</td>
                      <td className="text-right py-2 px-3 tabular-nums">{p.avg_price.toLocaleString()}</td>
                      <td className="text-right py-2 px-3 tabular-nums">{p.close.toLocaleString()}</td>
                      <td className="text-right py-2 px-3 tabular-nums">{krw(p.value)}</td>
                      <td
                        className={`text-right py-2 pl-3 tabular-nums font-medium ${p.pnl >= 0 ? 'text-status-success' : 'text-status-error'}`}
                      >
                        {signed(p.pnl)}
                        <span className="ml-1 text-[11px]">
                          ({p.pnlPct >= 0 ? '+' : ''}
                          {p.pnlPct.toFixed(1)}%)
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-[10px] text-txt-muted">
            현재가는 최근 수집된 종가 기준 (장중 실시간 아님).
          </p>
        </CardContent>
      </Card>

      {/* Trade ledger */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-heading">거래 내역</CardTitle>
        </CardHeader>
        <CardContent>
          {trades.length === 0 ? (
            <p className="text-sm text-txt-muted py-4">아직 거래가 없습니다.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-txt-muted border-b border-border-subtle">
                    <th className="text-left py-2 pr-3 font-medium">일자</th>
                    <th className="text-left py-2 px-3 font-medium">구분</th>
                    <th className="text-left py-2 px-3 font-medium">종목</th>
                    <th className="text-right py-2 px-3 font-medium">수량 × 단가</th>
                    <th className="text-right py-2 px-3 font-medium">금액</th>
                    <th className="text-right py-2 px-3 font-medium">비용</th>
                    <th className="text-right py-2 px-3 font-medium">실현손익</th>
                    <th className="text-left py-2 pl-3 font-medium">사유</th>
                    <th className="w-8 py-2" aria-label="상세" />
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id} className="border-b border-border-subtle/40 last:border-0">
                      <td className="py-2 pr-3 tabular-nums text-txt-secondary">{t.trade_date.slice(5)}</td>
                      <td className="py-2 px-3">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                            t.side === 'buy'
                              ? 'bg-status-success/10 text-status-success'
                              : 'bg-status-error/10 text-status-error'
                          }`}
                        >
                          {t.side === 'buy' ? '매수' : '매도'}
                        </span>
                      </td>
                      <td className="py-2 px-3 font-medium">{names.get(t.ticker) ?? t.ticker}</td>
                      <td className="text-right py-2 px-3 tabular-nums">
                        {t.qty.toLocaleString()} × {t.price.toLocaleString()}
                      </td>
                      <td className="text-right py-2 px-3 tabular-nums">{krw(t.amount)}</td>
                      <td className="text-right py-2 px-3 tabular-nums text-txt-muted">
                        {krw(t.fee + t.tax)}
                      </td>
                      <td
                        className={`text-right py-2 px-3 tabular-nums font-medium ${
                          t.realized_pnl == null
                            ? 'text-txt-muted'
                            : t.realized_pnl >= 0
                              ? 'text-status-success'
                              : 'text-status-error'
                        }`}
                      >
                        {t.realized_pnl == null ? '—' : signed(t.realized_pnl)}
                      </td>
                      <td className="py-2 pl-3 text-[12px] text-txt-secondary max-w-[260px] truncate">
                        {t.signal_grade ? `${GRADE_LABEL[t.signal_grade] ?? t.signal_grade} · ` : ''}
                        {t.reason ?? ''}
                      </td>
                      <td className="py-2 pl-1">
                        <TradeDetailButton
                          data={{
                            kind: 'trade',
                            name: names.get(t.ticker) ?? t.ticker,
                            ticker: t.ticker,
                            side: t.side,
                            date: t.trade_date,
                            qty: t.qty,
                            price: t.price,
                            amount: t.amount,
                            fee: t.fee,
                            tax: t.tax,
                            signal_grade: t.signal_grade,
                            reason: t.reason,
                            realized_pnl: t.realized_pnl,
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-txt-muted">
        체결 가정: 신호일 시가(09:00) ±0.05% 슬리피지 · 수수료 0.015% (양방향) · 매도 시 증권거래세
        0.15% — 실제 추종 가능한 가격만 사용합니다. 본 시뮬레이션은 가상 자금 기반이며 본 정보는 투자
        판단 보조 자료이며 매매 권유가 아닙니다.
      </p>
    </div>
  );
}
