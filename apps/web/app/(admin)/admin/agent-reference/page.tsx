import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Database,
  Filter,
  Gauge,
  Scale,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { type AgentName, type SignalGrade } from '@/lib/agents/types';

export const dynamic = 'force-static';
export const metadata = {
  title: 'AI 에이전트 참조 데이터 · QuantSignal',
};

/**
 * 한 페이지에서 한눈에 확인하는 AI 에이전트 참조 자료.
 *
 * 정보 소스:
 *   - agents/characters/*.py (에이전트별 입력 + 계산식)
 *   - agents/grading.py     (등급 매핑 + Taleb override)
 *   - agents/weights/constants.py (DEFAULT_WEIGHTS, M4 기준)
 *   - supabase/migrations/00000000000018~22  (DB 스키마)
 *
 * 페이지는 force-static — 정보 자체는 코드 정의된 상수이므로 DB 조회 불필요.
 */

interface AgentSpec {
  name: AgentName;
  label: string;
  role: string;
  vote: 'voter' | 'synth' | 'planned';
  milestone: string;
  tone: string;
  defaultWeight: number | null;
  inputs: string[];
  output: string;
  formula: string;
  sourceFile: string;
}

const AGENTS: AgentSpec[] = [
  {
    name: 'graham',
    label: 'Graham',
    role: '가치 분석가',
    vote: 'voter',
    milestone: 'M2',
    tone: 'text-txt-primary',
    defaultWeight: 0.18,
    inputs: ['kr_fundamentals (PE/PBR/ROE)', 'kr_financials 5Q+', 'korea_market (최근 종가)'],
    output: 'score (-2 ~ +2)',
    formula:
      'fair_pe = 8.5 + 2×growth%, fair_pbr = ROE×(1+g)  →  conservative = min(PER, PBR)  →  safety_margin → score',
    sourceFile: 'agents/characters/graham.py',
  },
  {
    name: 'dow',
    label: 'Dow',
    role: '기술 분석가',
    vote: 'voter',
    milestone: 'M2',
    tone: 'text-status-info',
    defaultWeight: 0.18,
    inputs: ['korea_market 200D+ quotes', 'volume'],
    output: 'score (-2 ~ +2)',
    formula:
      'MA5/20/60/200 + alignment (-3~+3) × 0.5, 거래량 미확인 시 ×0.6 감쇠  →  clamp(-2, +2)',
    sourceFile: 'agents/characters/dow.py',
  },
  {
    name: 'taleb',
    label: 'Taleb',
    role: '리스크 감시자',
    vote: 'voter',
    milestone: 'M4',
    tone: 'text-status-danger',
    defaultWeight: 0.13,
    inputs: ['korea_market 252D quotes', 'kr_financials (earnings window)'],
    output: 'score (-2 ~ +2) + severity (1 ~ 5)',
    formula:
      'asymmetry (252d vol + drawdown) + earnings 근접 패널티 + tail scenario  →  score + severity 버킷',
    sourceFile: 'agents/characters/taleb.py',
  },
  {
    name: 'shiller',
    label: 'Shiller',
    role: '시장사이클 분석가',
    vote: 'voter',
    milestone: 'M3',
    tone: 'text-status-warning',
    defaultWeight: 0.13,
    inputs: ['KOSPI MA200', '^VIX 20d avg', 'watchlist PE 중앙값', '5d 외인 순매수', '업종 MA60 돌파율'],
    output: 'score (-2 ~ +2)',
    formula:
      'fear-greed 5-component → regime_band (0~20 capitulation +2, 80~100 mania -2) + 종목 PE 보정',
    sourceFile: 'agents/characters/shiller.py',
  },
  {
    name: 'keynes',
    label: 'Keynes',
    role: '매크로 분석가',
    vote: 'voter',
    milestone: 'M3',
    tone: 'text-txt-secondary',
    defaultWeight: 0.18,
    inputs: ['USDKRW', '^TNX', '^VIX', 'DXY', 'WTI (5d delta)', 'kr_macro_betas (종목별 베타)'],
    output: 'score (-2 ~ +2)',
    formula: 'expected_return = Σ(beta[f] × delta_5d[f])  →  clamp(expected_return × 0.5, -2, +2)',
    sourceFile: 'agents/characters/keynes.py',
  },
  {
    name: 'turing',
    label: 'Turing',
    role: '기술패턴 인식기',
    vote: 'voter',
    milestone: 'M4',
    tone: 'text-txt-muted',
    defaultWeight: null,
    inputs: ['korea_market 35D+ quotes'],
    output: 'score (-2 ~ +2)',
    formula: 'RSI(14) + MACD(12,26,9) + Bollinger %b(20,2σ)  →  clamp(sum, -2, +2)',
    sourceFile: 'agents/characters/turing.py',
  },
  {
    name: 'simons',
    label: 'Simons',
    role: '퀀트 분석가 (ML)',
    vote: 'planned',
    milestone: 'M5 예정',
    tone: 'text-status-info',
    defaultWeight: 0.20,
    inputs: ['scikit-learn GBM 모델', 'score_predictions', 'pc_worker_heartbeat'],
    output: 'score (-2 ~ +2) + 상승확률 + 기대수익률',
    formula: 'PC 워커가 학습 → Supabase 적재 → 클라우드가 narrative 합성',
    sourceFile: 'signals/gbm.py + agents/characters/simons.py (설계 단계)',
  },
  {
    name: 'soros',
    label: 'Soros',
    role: '데스크 헤드 (합성기)',
    vote: 'synth',
    milestone: 'M2→M4',
    tone: 'text-txt-primary',
    defaultWeight: null,
    inputs: ['6 voter agents의 score', '최근 30D 가격', '사용자 weights', '이전 final_signal'],
    output: 'final_signal_grade + confidence + narrative',
    formula: 'Q1 가중합 → Q2 priced-in 감쇠 → Q3 Taleb override → Q4 confidence gate',
    sourceFile: 'agents/characters/soros.py',
  },
];

interface GradeRow {
  grade: SignalGrade;
  label: string;
  threshold: string;
  tone: string;
}

const GRADE_TABLE: GradeRow[] = [
  { grade: 'STRONG_BUY', label: '강한 관심', threshold: 'weighted_score ≥ +1.00', tone: 'text-status-success' },
  { grade: 'BUY', label: '관심', threshold: 'weighted_score ≥ +0.30', tone: 'text-status-success' },
  { grade: 'HOLD', label: '관망', threshold: 'weighted_score ≥ -0.30', tone: 'text-txt-secondary' },
  { grade: 'CAUTION', label: '주의', threshold: 'weighted_score ≥ -1.00', tone: 'text-status-warning' },
  { grade: 'RISK', label: '위험', threshold: 'weighted_score < -1.00', tone: 'text-status-danger' },
];

interface PipelineStep {
  q: string;
  title: string;
  icon: React.ReactNode;
  description: string;
  bullets: string[];
}

const PIPELINE: PipelineStep[] = [
  {
    q: 'Q1',
    title: '가중 합산 (Weighted Sum)',
    icon: <Scale className="h-4 w-4 text-status-info" />,
    description: '각 voter의 score에 사용자별 가중치를 곱해 합산',
    bullets: [
      'shares = normalize(user.weights / Σ weights)',
      'q1_score = Σ(share[i] × score[i])',
      '범위 외 가중치는 pin-and-scale 알고리즘으로 정규화 (최대 6회 수렴)',
    ],
  },
  {
    q: 'Q2',
    title: '시장반영도 감쇠 (Priced-In Dampening)',
    icon: <Filter className="h-4 w-4 text-status-warning" />,
    description: 'Claude LLM이 priced_in (0~1) 평가 — 이미 가격에 반영됐는지 판단',
    bullets: [
      'priced_in > 0.70  →  q2 = q1 × 0.5 (감쇠)',
      'priced_in ≤ 0.70  →  q2 = q1 (통과)',
      'cached voter narrative + 최근 30D 가격으로 LLM 1회 호출',
    ],
  },
  {
    q: 'Q3',
    title: 'Taleb 자동 제약 (Risk Override)',
    icon: <ShieldAlert className="h-4 w-4 text-status-danger" />,
    description: 'Taleb severity가 높으면 상위 등급을 강제 하향',
    bullets: [
      'severity = 4  →  한 단계 하향 (STRONG_BUY→BUY→HOLD→CAUTION→RISK)',
      'severity ≥ 5  →  STRONG_BUY/BUY를 HOLD로 강제',
      'final_signals.taleb_override = true 로 audit 기록',
    ],
  },
  {
    q: 'Q4',
    title: '신뢰도 게이트 (Confidence Gate)',
    icon: <Gauge className="h-4 w-4 text-status-info" />,
    description: 'voter 간 동의도가 낮으면 강한 등급을 demote',
    bullets: [
      'confidence = voter_agreement_score() (분산 + 방향성 합의도)',
      'STRONG_BUY + confidence < 0.70  →  BUY',
      'BUY + confidence < 0.50  →  HOLD',
    ],
  },
];

function voteBadge(vote: AgentSpec['vote']) {
  if (vote === 'voter') {
    return (
      <Badge variant="outline" className="text-[10px] border-border-divider">
        Voter
      </Badge>
    );
  }
  if (vote === 'synth') {
    return (
      <Badge variant="outline" className="text-[10px] border-status-info/40 text-status-info">
        Synthesizer
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] border-status-warning/40 text-status-warning">
      Planned
    </Badge>
  );
}

function fmtWeight(w: number | null): string {
  if (w == null) return '—';
  return `${(w * 100).toFixed(0)}%`;
}

export default function AgentReferencePage() {
  const voters = AGENTS.filter((a) => a.vote === 'voter');
  const synth = AGENTS.filter((a) => a.vote === 'synth');
  const planned = AGENTS.filter((a) => a.vote === 'planned');

  const weightTotal = voters
    .filter((a) => a.defaultWeight != null)
    .reduce((sum, a) => sum + (a.defaultWeight ?? 0), 0);

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-status-info" />
            AI 에이전트 참조 데이터
          </h1>
          <p className="mt-1 text-sm text-txt-secondary">
            8명의 에이전트가 각각 무엇을 보고, 어떻게 합쳐져서 최종 신호가 되는지 한눈에.
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

      {/* Section 1 — Agents */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-4 w-4 text-txt-primary" />
            에이전트별 참조 데이터 (입력 → 출력)
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-txt-muted border-b border-border-divider">
                <th className="px-4 py-2 font-medium">에이전트</th>
                <th className="px-4 py-2 font-medium">역할</th>
                <th className="px-4 py-2 font-medium">참조 데이터</th>
                <th className="px-4 py-2 font-medium">계산식 요약</th>
                <th className="px-4 py-2 font-medium">출력</th>
                <th className="px-4 py-2 font-medium text-right">기본 가중치</th>
              </tr>
            </thead>
            <tbody>
              {AGENTS.map((a) => (
                <tr
                  key={a.name}
                  className="border-b border-border-subtle last:border-0 align-top hover:bg-surface-hover/50 transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-medium ${a.tone}`}>{a.label}</span>
                      {voteBadge(a.vote)}
                    </div>
                    <div className="text-[10px] text-txt-muted mt-0.5">{a.milestone}</div>
                  </td>
                  <td className="px-4 py-3 text-txt-secondary whitespace-nowrap">{a.role}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {a.inputs.map((inp) => (
                        <span
                          key={inp}
                          className="inline-flex items-center rounded-md border border-border-subtle bg-surface-elevated px-1.5 py-0.5 text-[11px] text-txt-secondary"
                        >
                          {inp}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-txt-secondary font-mono leading-relaxed max-w-md">
                    {a.formula}
                    <div className="mt-1 text-[10px] text-txt-muted">
                      <code>{a.sourceFile}</code>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-txt-secondary whitespace-nowrap">{a.output}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-mono text-sm">
                    {fmtWeight(a.defaultWeight)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="text-xs text-txt-muted">
                <td colSpan={5} className="px-4 py-2 text-right">
                  Voter 가중치 합계
                </td>
                <td className="px-4 py-2 text-right tabular-nums font-mono">
                  {(weightTotal * 100).toFixed(0)}%
                </td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>

      {/* Section 2 — Pipeline */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-status-info" />
            최종 판단 파이프라인 (Soros Synthesis)
          </CardTitle>
          <p className="text-xs text-txt-muted mt-1">
            6명의 voter 점수 → Q1~Q4 단계 → final_signals 테이블에 기록
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
            {PIPELINE.map((step, idx) => (
              <div key={step.q} className="relative">
                <div className="rounded-lg border border-border-divider bg-surface-elevated p-3 h-full">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="outline" className="text-[10px] border-border-strong font-mono">
                      {step.q}
                    </Badge>
                    {step.icon}
                    <span className="text-sm font-medium text-txt-primary">{step.title}</span>
                  </div>
                  <p className="text-xs text-txt-secondary mb-2 leading-relaxed">
                    {step.description}
                  </p>
                  <ul className="space-y-1">
                    {step.bullets.map((b) => (
                      <li
                        key={b}
                        className="text-[11px] text-txt-muted font-mono leading-snug pl-2 relative before:content-['›'] before:absolute before:left-0 before:text-txt-muted"
                      >
                        {b}
                      </li>
                    ))}
                  </ul>
                </div>
                {idx < PIPELINE.length - 1 && (
                  <div className="hidden lg:flex absolute top-1/2 -right-2 -translate-y-1/2 z-10">
                    <ArrowRight className="h-4 w-4 text-txt-muted" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Section 3 — Grade mapping + DB schema */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">시그널 등급 매핑</CardTitle>
            <p className="text-xs text-txt-muted mt-1">
              <code>agents/grading.py · score_to_signal_grade()</code>
            </p>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {GRADE_TABLE.map((g) => (
              <div
                key={g.grade}
                className="flex items-center justify-between gap-3 text-sm border-b border-border-subtle pb-1.5 last:border-0"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={`text-[10px] ${g.tone} border-current/40`}>
                    {g.grade}
                  </Badge>
                  <span className={g.tone}>{g.label}</span>
                </div>
                <code className="text-[11px] text-txt-muted font-mono">{g.threshold}</code>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">결과 저장 위치 (DB)</CardTitle>
            <p className="text-xs text-txt-muted mt-1">
              <code>supabase/migrations/18~22</code>
            </p>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div className="rounded-md border border-border-subtle bg-surface-elevated p-2">
              <div className="font-mono font-medium text-txt-primary">agent_outputs</div>
              <p className="text-txt-muted mt-0.5">
                cycle마다 8개 에이전트의 score · severity · narrative · llm_cost_usd
              </p>
            </div>
            <div className="rounded-md border border-border-subtle bg-surface-elevated p-2">
              <div className="font-mono font-medium text-txt-primary">final_signals</div>
              <p className="text-txt-muted mt-0.5">
                signal_grade · weighted_score · confidence · weights_snapshot · taleb_override
              </p>
            </div>
            <div className="rounded-md border border-border-subtle bg-surface-elevated p-2">
              <div className="font-mono font-medium text-txt-primary">signal_change_events</div>
              <p className="text-txt-muted mt-0.5">
                등급 전환 audit trail (from_grade → to_grade, reason, notified_at)
              </p>
            </div>
            <div className="rounded-md border border-border-subtle bg-surface-elevated p-2">
              <div className="font-mono font-medium text-txt-primary">
                user_weight_settings · weight_settings_history · soros_weight_adjustments
              </div>
              <p className="text-txt-muted mt-0.5">
                사용자별 가중치 + 변경 이력 + Soros 임시 오버레이 (×0.5 ~ ×1.5)
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Section 4 — Summary footer */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Voter / Synthesizer 구성</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div className="rounded-md border border-border-subtle bg-surface-elevated p-3">
              <div className="text-xs text-txt-muted uppercase tracking-wider mb-1">Voters</div>
              <div className="font-heading text-xl font-semibold">{voters.length}명</div>
              <p className="text-[11px] text-txt-muted mt-1">
                {voters.map((v) => v.label).join(', ')}
              </p>
            </div>
            <div className="rounded-md border border-border-subtle bg-surface-elevated p-3">
              <div className="text-xs text-txt-muted uppercase tracking-wider mb-1">Synthesizer</div>
              <div className="font-heading text-xl font-semibold">{synth.length}명</div>
              <p className="text-[11px] text-txt-muted mt-1">
                {synth.map((s) => s.label).join(', ')} — voter 결과 합성 + LLM narrative
              </p>
            </div>
            <div className="rounded-md border border-border-subtle bg-surface-elevated p-3">
              <div className="text-xs text-txt-muted uppercase tracking-wider mb-1">Planned</div>
              <div className="font-heading text-xl font-semibold">{planned.length}명</div>
              <p className="text-[11px] text-txt-muted mt-1">
                {planned.map((p) => p.label).join(', ')} — M5에서 활성화 예정
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
