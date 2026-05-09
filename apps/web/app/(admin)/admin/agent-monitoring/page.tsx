import { Activity, AlertTriangle, DollarSign, Layers3 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getQueryClient } from '@/lib/supabase/query-client';
import { gradeBand } from '@/lib/agents/grade';
import { type AgentName, type SignalGrade } from '@/lib/agents/types';

export const dynamic = 'force-dynamic';

interface DailyRow {
  agent_name: AgentName;
  cycle_date: string;
  output_count: number;
  avg_score: number | null;
  severity_4plus_count: number;
  total_cost_usd: number | null;
}

interface GradeRow {
  signal_grade: SignalGrade;
  ticker_count: number;
  avg_confidence: number | null;
  taleb_override_count: number;
}

interface WeightDistRow {
  agent_name: AgentName;
  user_count: number;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  min_weight: number | null;
  max_weight: number | null;
}

interface TalebAlertRow {
  id: string;
  ticker: string | null;
  cycle_at: string;
  severity: number;
  narrative: string;
}

const AGENT_DISPLAY: Record<AgentName, { label: string; tone: string }> = {
  soros: { label: 'Soros', tone: 'text-brand-purple' },
  taleb: { label: 'Taleb', tone: 'text-status-danger' },
  simons: { label: 'Simons', tone: 'text-status-info' },
  graham: { label: 'Graham', tone: 'text-status-success' },
  dow: { label: 'Dow', tone: 'text-status-info' },
  shiller: { label: 'Shiller', tone: 'text-status-warning' },
  keynes: { label: 'Keynes', tone: 'text-txt-secondary' },
  turing: { label: 'Turing', tone: 'text-txt-muted' },
};

function pct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return `${(Number(n) * 100).toFixed(1)}%`;
}

function fmtUsd(n: number | null | undefined): string {
  if (!n) return '$0.00';
  return `$${Number(n).toFixed(4)}`;
}

export default async function AgentMonitoringPage() {
  const sb = await getQueryClient();
  const since = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);

  const [dailyRes, gradeRes, weightsRes, talebRes] = await Promise.all([
    sb.from('v_agent_output_daily').select('*').gte('cycle_date', since).order('cycle_date', { ascending: false }),
    sb.from('v_signal_grade_current').select('*'),
    sb.from('v_user_weight_distribution').select('*'),
    sb.from('v_taleb_alerts_recent').select('*').limit(10),
  ]);

  const daily = (dailyRes.data ?? []) as DailyRow[];
  const grades = (gradeRes.data ?? []) as GradeRow[];
  const weights = (weightsRes.data ?? []) as WeightDistRow[];
  const taleb = (talebRes.data ?? []) as TalebAlertRow[];

  // KPI rollups.
  const totals = daily.reduce(
    (acc, r) => {
      acc.calls += r.output_count;
      acc.cost += r.total_cost_usd ?? 0;
      acc.severity4 += r.severity_4plus_count;
      return acc;
    },
    { calls: 0, cost: 0, severity4: 0 },
  );

  // Per-agent rollup over the 14-day window.
  const byAgent = daily.reduce<Map<AgentName, DailyRow & { count: number }>>(
    (m, r) => {
      const cur = m.get(r.agent_name);
      if (cur) {
        cur.output_count += r.output_count;
        cur.severity_4plus_count += r.severity_4plus_count;
        cur.total_cost_usd =
          (cur.total_cost_usd ?? 0) + (r.total_cost_usd ?? 0);
        cur.count += 1;
      } else {
        m.set(r.agent_name, { ...r, count: 1 });
      }
      return m;
    },
    new Map(),
  );

  return (
    <div className="space-y-5 fade-in">
      <header>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          AI 에이전트 모니터링
        </h1>
        <p className="mt-1 text-sm text-txt-secondary">
          최근 14일 LLM 호출 비용 + 시그널 등급 분포 + Taleb 위험 경보. 이 대시보드는
          마이그레이션 22의 4개 뷰를 직접 읽습니다.
        </p>
      </header>

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard
          icon={<Activity className="h-4 w-4 text-status-success" />}
          label="14일 누적 호출"
          value={totals.calls.toLocaleString('ko-KR')}
          hint={daily.length === 0 ? '데이터 없음' : `${daily.length} 일자별 행`}
        />
        <KpiCard
          icon={<DollarSign className="h-4 w-4 text-brand-purple" />}
          label="14일 누적 비용"
          value={fmtUsd(totals.cost)}
          hint="Sonnet 기준 추정 (cache reads 90% off 적용)"
        />
        <KpiCard
          icon={<AlertTriangle className="h-4 w-4 text-status-danger" />}
          label="Taleb sev 4+ 경보"
          value={totals.severity4.toLocaleString('ko-KR')}
          hint="자동 시그널 하향 트리거 횟수"
        />
      </div>

      {/* Per-agent rollup */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">에이전트별 14일 누적</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-txt-muted border-b border-border-divider">
                <th className="px-4 py-2">에이전트</th>
                <th className="px-4 py-2 text-right">호출</th>
                <th className="px-4 py-2 text-right">비용 USD</th>
                <th className="px-4 py-2 text-right">sev 4+</th>
                <th className="px-4 py-2 text-right">관측 일수</th>
              </tr>
            </thead>
            <tbody>
              {byAgent.size === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-xs text-txt-muted"
                  >
                    아직 ``agent_outputs``에 적재된 행이 없습니다. M2 첫 사이클이
                    돌면 자동 채워집니다.
                  </td>
                </tr>
              )}
              {Array.from(byAgent.entries())
                .sort(([, a], [, b]) => b.output_count - a.output_count)
                .map(([agentRaw, row]) => {
                  const agent = agentRaw as AgentName;
                  return (
                  <tr key={agent} className="border-b border-border-subtle">
                    <td className="px-4 py-2 font-medium">
                      <span className={AGENT_DISPLAY[agent].tone}>
                        {AGENT_DISPLAY[agent].label}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {row.output_count.toLocaleString('ko-KR')}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {fmtUsd(row.total_cost_usd)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {row.severity_4plus_count > 0 ? (
                        <Badge
                          variant="outline"
                          className="border-status-danger/40 text-status-danger"
                        >
                          {row.severity_4plus_count}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-txt-muted">
                      {row.count}
                    </td>
                  </tr>
                  );
                })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Signal grade distribution */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">현재 시그널 등급 분포</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {grades.length === 0 && (
              <p className="text-xs text-txt-muted">final_signals 비어 있음.</p>
            )}
            {grades.map((g) => {
              const band = gradeBand(g.signal_grade);
              return (
                <div
                  key={g.signal_grade}
                  className="flex items-center justify-between gap-3 text-sm border-b border-border-subtle pb-1.5 last:border-0"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      {g.signal_grade}
                    </Badge>
                    <span className="text-txt-secondary">{band.label}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-txt-muted">
                    <span>conf {pct(g.avg_confidence)}</span>
                    {g.taleb_override_count > 0 && (
                      <span className="text-status-danger">
                        Taleb 강제 ↓ {g.taleb_override_count}
                      </span>
                    )}
                    <span className="font-mono tabular-nums text-txt-primary">
                      {g.ticker_count}종목
                    </span>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* User weight distribution */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">사용자 가중치 분포</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {weights.length === 0 && (
              <p className="text-xs text-txt-muted">
                user_weight_settings에 저장된 사용자 없음.
              </p>
            )}
            {weights.map((w) => (
              <div
                key={w.agent_name}
                className="flex items-center justify-between gap-2 text-xs border-b border-border-subtle pb-1.5 last:border-0"
              >
                <span className={AGENT_DISPLAY[w.agent_name].tone}>
                  {AGENT_DISPLAY[w.agent_name].label}
                </span>
                <span className="font-mono tabular-nums text-txt-secondary">
                  p25 {pct(w.p25)} · <span className="text-txt-primary">p50 {pct(w.p50)}</span> · p75{' '}
                  {pct(w.p75)} <span className="text-txt-muted">(n={w.user_count})</span>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Recent Taleb alerts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-status-danger" />
            Taleb 위험 경보 (severity 4+)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {taleb.length === 0 && (
            <p className="text-xs text-txt-muted">최근 high-severity 경보 없음.</p>
          )}
          {taleb.map((alert) => (
            <div
              key={alert.id}
              className="text-sm border-l-2 border-status-danger/60 pl-3 py-1"
            >
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-status-danger/40 text-status-danger text-[10px]"
                >
                  sev {alert.severity}
                </Badge>
                {alert.ticker && (
                  <span className="font-mono text-xs text-txt-muted">
                    {alert.ticker}
                  </span>
                )}
                <span className="text-[10px] text-txt-muted ml-auto">
                  {alert.cycle_at.replace('T', ' ').slice(0, 16)}
                </span>
              </div>
              <p className="mt-0.5 text-txt-secondary line-clamp-2">
                {alert.narrative}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <p className="text-xs text-txt-muted flex items-center gap-1">
        <Layers3 className="h-3 w-3" />
        뷰 정의: <code>v_agent_output_daily</code>, <code>v_signal_grade_current</code>,{' '}
        <code>v_user_weight_distribution</code>, <code>v_taleb_alerts_recent</code> ·
        마이그레이션 22.
      </p>
    </div>
  );
}

interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}

function KpiCard({ icon, label, value, hint }: KpiCardProps) {
  return (
    <Card>
      <CardContent className="p-4 space-y-1">
        <div className="flex items-center gap-2 text-xs text-txt-muted uppercase tracking-wider">
          {icon}
          {label}
        </div>
        <div className="font-heading text-2xl font-semibold tabular-nums">
          {value}
        </div>
        {hint && <div className="text-[11px] text-txt-muted">{hint}</div>}
      </CardContent>
    </Card>
  );
}
