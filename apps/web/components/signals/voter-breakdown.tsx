import {
  Activity,
  AlertTriangle,
  BarChart3,
  Cpu,
  Globe,
  Info,
  ShieldCheck,
  Waves,
} from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { gradeToLabel, type SignalGrade } from '@/lib/signal-resolver';
import type { VoterBreakdown, VoterRow } from '@/lib/queries/voters';

/**
 * Per-voter metadata — name, domain, accent color, icon, score-band
 * interpretation. Centralised so the spectrum + card both consume the
 * same source of truth.
 */
interface VoterMeta {
  name: string;
  domain: string;
  /** One-line "what this character measures". Shown under the name. */
  philosophy: string;
  /** Lucide icon — picked to evoke the analyst's discipline. */
  icon: React.ComponentType<{ className?: string }>;
  /** Hex for the avatar + bar accent. Distinct hues, all readable on the
   *  light + dark themes. */
  accent: string;
  /** Real-world inspiration — shown in the hover bio popover. */
  realName: string;
  era: string;
  bio: string;
  /** Concrete inputs / methods this voter uses in the QuantSignal pipeline. */
  inputs: string[];
}

const VOTER_META: Record<string, VoterMeta> = {
  graham: {
    name: 'Graham', domain: '가치', philosophy: '안전마진 · ROE · PER',
    icon: ShieldCheck, accent: '#7C8FA8',
    realName: 'Benjamin Graham (1894–1976)',
    era: '대공황 — 가치투자의 아버지',
    bio:
      '《Security Analysis》(1934), 《The Intelligent Investor》(1949) 저자. ' +
      "워런 버핏의 스승. '내재가치 - 시장가격 = 안전마진' 개념을 정립했고, " +
      'PER × EPS, PBR × BPS의 보수적 minimum을 본질가치로 사용.',
    inputs: ['forwardPE / trailingPE', 'PBR · ROE', '매출 · 영업이익 YoY (5분기 평균)'],
  },
  dow: {
    name: 'Dow', domain: '추세', philosophy: '이평선 정렬 · 모멘텀',
    icon: Activity, accent: '#5B8DEF',
    realName: 'Charles Dow (1851–1902)',
    era: '월스트리트 저널 창립자 · 다우 이론',
    bio:
      "월스트리트 저널과 다우존스 지수의 창립자. '추세는 친구다' 격언의 시초. " +
      "다우 이론(주추세·중기·단기 3축)으로 시장이 명확한 방향성을 갖는다는 가설을 정립.",
    inputs: ['200일/60일/20일 이평선 정렬', '거래량 5일 vs 20일 비율', '52주 신고가 근접도'],
  },
  turing: {
    name: 'Turing', domain: '기술', philosophy: 'RSI · MACD · Bollinger',
    icon: Cpu, accent: '#A06CD5',
    realName: 'Alan Turing (1912–1954)',
    era: '컴퓨터 과학 · 기계학습의 시조',
    bio:
      '암호 해독(에니그마)과 보편 튜링 기계로 알고리즘 가능성을 정의. ' +
      "QuantSignal에서는 '패턴은 수치로 환원된다'는 그의 관점을 따라 순수 기술지표만 사용.",
    inputs: ['RSI(14) 과매수/과매도', 'MACD(12,26,9) 크로스오버', 'Bollinger %b(20, 2σ)'],
  },
  shiller: {
    name: 'Shiller', domain: '사이클', philosophy: 'CAPE · 매출 추세',
    icon: Waves, accent: '#3DA88C',
    realName: 'Robert Shiller (1946– )',
    era: '예일대 · 노벨 경제학상(2013)',
    bio:
      '《Irrational Exuberance》(2000)에서 닷컴 버블 경고. ' +
      'CAPE(Cyclically-Adjusted PE, 10년 평균 수익 기반) 지표 창안. ' +
      '시장이 기업 펀더멘털이 아닌 군중 심리에 의해 왜곡된다는 입장.',
    inputs: ['forwardPE vs 섹터 중앙값', '매출 추세 5분기 회귀', '시장 regime (과열/저평가)'],
  },
  keynes: {
    name: 'Keynes', domain: '거시', philosophy: 'USD · 금리 · VIX · WTI · DXY 베타',
    icon: Globe, accent: '#E59B47',
    realName: 'John Maynard Keynes (1883–1946)',
    era: '거시경제학의 창시자 · 경제학자 겸 투자자',
    bio:
      '《일반이론》(1936) 저자. 정부 재정정책의 효과를 이론화. ' +
      '본인은 King\'s College Cambridge의 펀드 매니저로 영국채·환율·원자재 활용. ' +
      "'시장은 당신이 견딜 수 있는 기간보다 더 오래 비합리적일 수 있다' 명언.",
    inputs: ['USDKRW · ^TNX(미 10년) · ^VIX · DXY · WTI', '종목별 5개 매크로 베타', '5요소 합산 기대 변동 %p'],
  },
  taleb: {
    name: 'Taleb', domain: '리스크', philosophy: '꼬리위험 · 이벤트',
    icon: AlertTriangle, accent: '#D85A6A',
    realName: 'Nassim Nicholas Taleb (1960– )',
    era: '《블랙스완》 · 안티프래질',
    bio:
      '《Fooled by Randomness》(2001), 《The Black Swan》(2007) 저자. ' +
      '정규분포가 무시하는 꼬리 사건이 시장 손익의 본질이라는 입장. ' +
      'QuantSignal에서는 severity 1-5 등급 + 자동 강등 룰로 강세 신호에 brake를 검.',
    inputs: ['90일 최대 drawdown', '90일 변동성 (연환산)', '비대칭 비율 (상승/하락)', 'D-7 earnings 임박'],
  },
  simons: {
    name: 'Simons', domain: 'ML', philosophy: 'GBM · 패턴 학습',
    icon: BarChart3, accent: '#6BB6FF',
    realName: 'James Simons (1938–2024)',
    era: 'Renaissance Technologies · Medallion Fund',
    bio:
      "수학자(미분기하학)에서 헤지펀드 매니저로 전향. Medallion 펀드는 30년간 연 66% 수익. " +
      "'어떤 이론도 시장을 완벽히 설명할 수 없으니, 데이터로 패턴만 찾는다' 입장. " +
      'QuantSignal에서는 GBM 분류기로 다음날 +1% 확률을 예측.',
    inputs: ['14개 피처 (기술 + 매크로 + 뉴스)', 'GradientBoosting · CalibratedClassifier', '시계열 GroupKFold 검증'],
  },
};

/** Color band that mirrors SIGNAL_TONE so the bar/score color reads the
 *  same as the badge color elsewhere on the page. */
function scoreColor(score: number): string {
  if (score >= 1.0)   return 'rgb(72,166,152)';   // success
  if (score >= 0.3)   return '#7CC97E';
  if (score >= -0.3)  return 'rgb(170,170,170)';
  if (score >= -1.0)  return '#E9B247';
  return 'rgb(220,72,72)';
}

/** Plain-language one-liner for the voter score band. */
function scoreVerdict(score: number): string {
  if (score >= 1.5)   return '강한 긍정';
  if (score >= 0.5)   return '긍정';
  if (score >= -0.5)  return '중립';
  if (score >= -1.5)  return '부정';
  return '강한 부정';
}

// ─── Sub-components ────────────────────────────────────────────────

/** Mini horizontal spectrum: 6 vertical bars, centered at 0, height
 *  proportional to |score|. Color follows scoreColor(). Lets a user
 *  read the consensus shape in 1 second. */
function VoterSpectrum({ voters }: { voters: VoterRow[] }) {
  return (
    <div className="rounded-md border border-border-subtle/60 bg-bg-secondary/40 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-txt-muted mb-2">
        voter 분포
      </div>
      <div className="flex items-end gap-1.5 h-16">
        {voters.map((v) => {
          const meta = VOTER_META[v.agent_name];
          if (!meta) return null;
          const magnitude = Math.min(1, Math.abs(v.score) / 2); // 0..1
          const heightPct = 8 + magnitude * 92; // 8% min so 0-voters still visible
          const isPositive = v.score >= 0;
          return (
            <div
              key={v.agent_name}
              className="flex-1 flex flex-col items-center gap-1 group"
              title={`${meta.name}: ${v.score.toFixed(2)}`}
            >
              <div className="flex-1 w-full flex items-end justify-center relative">
                {/* Center axis line */}
                <div className="absolute left-0 right-0 top-1/2 h-px bg-border-default/30" />
                <div
                  className={cn(
                    'w-full rounded-sm transition-all',
                    isPositive ? 'self-end' : 'self-start',
                  )}
                  style={{
                    height: `${heightPct / 2}%`,
                    background: scoreColor(v.score),
                    marginTop: isPositive ? `${50 - heightPct / 2}%` : '50%',
                  }}
                />
              </div>
              <div className="text-[9px] font-medium text-txt-secondary">
                {meta.name}
              </div>
              <div
                className="text-[10px] font-mono tabular-nums"
                style={{ color: scoreColor(v.score) }}
              >
                {v.score >= 0 ? '+' : ''}
                {v.score.toFixed(1)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Individual voter card with avatar, score, micro-bar, narrative. */
function VoterCard({
  voter,
  weight,
}: {
  voter: VoterRow;
  weight: number | undefined;
}) {
  const meta = VOTER_META[voter.agent_name];
  if (!meta) return null;
  const Icon = meta.icon;
  const color = scoreColor(voter.score);
  const verdict = scoreVerdict(voter.score);
  const barPct = Math.min(100, (Math.abs(voter.score) / 2) * 50);
  return (
    <div className="rounded-md border border-border-subtle/60 bg-bg-secondary/40 p-3 hover:border-border-default/60 transition-colors">
      {/* Top: avatar + name + domain */}
      <div className="flex items-start gap-2.5 mb-2">
        {/* Avatar with hover bio popover. Pure CSS — no Radix needed. */}
        <div className="relative shrink-0 group/avatar">
          <button
            type="button"
            aria-label={`${meta.name} 프로필`}
            className="h-9 w-9 rounded-full flex items-center justify-center transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-brand-purple/50"
            style={{
              background: `${meta.accent}22`,
              color: meta.accent,
            }}
          >
            <Icon className="h-4 w-4" />
          </button>
          {/* Bio popover — appears on hover/focus of the avatar */}
          <div
            className="absolute left-0 top-full mt-1 z-30 w-72 rounded-md border border-border-default bg-bg-secondary p-3 shadow-lg opacity-0 invisible group-hover/avatar:opacity-100 group-hover/avatar:visible group-focus-within/avatar:opacity-100 group-focus-within/avatar:visible transition-opacity duration-150 pointer-events-none"
            role="tooltip"
          >
            <div
              className="text-xs font-semibold mb-0.5"
              style={{ color: meta.accent }}
            >
              {meta.realName}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-txt-muted mb-2">
              {meta.era}
            </div>
            <p className="text-[11px] leading-relaxed text-txt-primary mb-2">
              {meta.bio}
            </p>
            <div className="text-[10px] uppercase tracking-wider text-txt-muted mb-1">
              사용 데이터
            </div>
            <ul className="text-[11px] text-txt-secondary space-y-0.5">
              {meta.inputs.map((input) => (
                <li key={input} className="flex gap-1">
                  <span style={{ color: meta.accent }}>·</span>
                  <span>{input}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="font-semibold text-sm">{meta.name}</span>
            <span className="text-[10px] text-txt-muted">{meta.domain}</span>
          </div>
          <div className="text-[10px] text-txt-muted truncate" title={meta.philosophy}>
            {meta.philosophy}
          </div>
        </div>
        {weight != null && (
          <span className="text-[9px] text-txt-muted tabular-nums shrink-0">
            w {Math.round(weight * 100)}%
          </span>
        )}
      </div>

      {/* Score + verdict */}
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-wider text-txt-muted">
          {verdict}
        </span>
        <span
          className="font-mono tabular-nums text-base font-semibold"
          style={{ color }}
        >
          {voter.score >= 0 ? '+' : ''}
          {voter.score.toFixed(2)}
        </span>
      </div>

      {/* Bipolar bar */}
      <div className="relative h-1.5 rounded-full bg-bg-tertiary/40 overflow-hidden mb-2">
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border-default/60" />
        <div
          className={cn(
            'absolute top-0 bottom-0 transition-all rounded-full',
            voter.score >= 0 ? 'left-1/2' : 'right-1/2',
          )}
          style={{ width: `${barPct}%`, background: color }}
        />
      </div>

      {/* Truncated narrative — 2 lines, ellipsis */}
      {voter.narrative && (
        <p
          className="text-[11px] text-txt-secondary line-clamp-2 leading-snug"
          title={voter.narrative}
        >
          {voter.narrative}
        </p>
      )}
    </div>
  );
}

// ─── Main card ─────────────────────────────────────────────────────

export function VoterBreakdownCard({ data }: { data: VoterBreakdown }) {
  const grade = data.signal_grade as SignalGrade;
  const label = gradeToLabel(grade);
  const weights = data.weights_snapshot ?? {};
  const confPct = data.confidence != null ? Math.round(data.confidence * 100) : null;
  const weightedScore = data.weighted_score;
  const strengthPct =
    weightedScore != null ? Math.round(((weightedScore + 2) / 4) * 100) : null;
  const activeCount = data.voters.filter((v) => Math.abs(v.score) >= 0.1).length;

  // Tier coloring for the agreement readout.
  const confTone =
    confPct == null
      ? 'text-txt-muted'
      : confPct < 50
        ? 'text-status-warning'
        : confPct >= 70
          ? 'text-status-success'
          : 'text-txt-primary';

  // Grade color band — drives the hero label and the accent stripe.
  const gradeAccent =
    grade === 'STRONG_BUY' ? 'rgb(72,166,152)'
    : grade === 'BUY'      ? '#7CC97E'
    : grade === 'HOLD'     ? 'rgb(170,170,170)'
    : grade === 'CAUTION'  ? '#E9B247'
    :                        'rgb(220,72,72)';

  return (
    <Card className="border-brand-purple/20 relative">
      {/* Accent stripe — quick visual cue for the grade without reading.
          Sits inside the rounded corners via rounded-t-lg to inherit the
          Card's shape; absolutely positioned so it doesn't push content. */}
      <div
        className="absolute top-0 left-0 right-0 h-1 rounded-t-lg pointer-events-none"
        style={{ background: gradeAccent }}
      />

      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle className="text-base font-heading flex items-center gap-2">
            <span className="inline-block h-6 w-6 rounded-full bg-gradient-brand" />
            6-Voter 합의
          </CardTitle>
          <div className="flex items-center gap-2 text-[11px] text-txt-muted">
            <span>
              cycle{' '}
              <span className="font-mono">
                {data.cycle_at.slice(0, 16).replace('T', ' ')}
              </span>
            </span>
            {data.taleb_override && (
              <Badge variant="outline" className="border-status-danger/40 text-status-danger">
                Taleb override sev {data.taleb_severity}
              </Badge>
            )}
            {(weights as Record<string, unknown>)['confidence_gate_applied'] === true && (
              <Badge variant="outline" className="border-status-warning/40 text-status-warning">
                신뢰도 게이트 적용
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* ── Hero block: at-a-glance verdict ──────────────────────── */}
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Grade + strength */}
          <div className="rounded-md border border-border-subtle/60 bg-bg-secondary/40 p-3">
            <div className="text-[10px] uppercase tracking-wider text-txt-muted mb-1">
              최종 등급
            </div>
            <div
              className="text-xl font-bold leading-tight"
              style={{ color: gradeAccent }}
            >
              {label}
            </div>
            <div className="mt-2 flex items-baseline gap-3 text-xs">
              <span className="text-txt-muted">가중 점수</span>
              <span className="font-mono tabular-nums font-medium">
                {weightedScore != null ? weightedScore.toFixed(2) : '—'}
              </span>
              {strengthPct !== null && (
                <>
                  <span className="text-txt-muted ml-1">방향 강도</span>
                  <span className="font-mono tabular-nums font-medium">
                    {strengthPct}/100
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Confidence + active voters */}
          <div className="rounded-md border border-border-subtle/60 bg-bg-secondary/40 p-3">
            <div className="text-[10px] uppercase tracking-wider text-txt-muted mb-1">
              voter 합의
            </div>
            <div className={cn('text-xl font-bold leading-tight', confTone)}>
              {confPct != null ? `${confPct}%` : '—'}
            </div>
            <div className="mt-2 flex items-baseline gap-3 text-xs">
              <span className="text-txt-muted">active</span>
              <span className="font-mono tabular-nums font-medium">
                {activeCount} / {data.voters.length}
              </span>
              <span className="text-txt-muted ml-1">|score| ≥ 0.1</span>
            </div>
          </div>
        </div>

        {/* Low-confidence warning */}
        {confPct != null && confPct < 50 && (
          <div className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-status-warning">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <div>
              voter 의견 분산 ({confPct}%) — 단일 voter가 신호를 주도합니다.
              다음 사이클에서 합의가 강해지는지 함께 확인하세요.
            </div>
          </div>
        )}

        {/* ── Spectrum: all voters at a glance ──────────────────── */}
        <VoterSpectrum voters={data.voters} />

        {/* ── Voter cards grid ──────────────────────────────────── */}
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {data.voters.map((v) => (
            <VoterCard
              key={v.agent_name}
              voter={v}
              weight={weights[v.agent_name] as number | undefined}
            />
          ))}
        </div>

        {/* ── Soros synthesis quote ─────────────────────────────── */}
        {data.narrative && (
          <div className="rounded-md border-l-4 border-brand-purple bg-brand-purple/5 px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="inline-block h-4 w-4 rounded-full bg-gradient-brand" />
              <span className="text-[10px] uppercase tracking-wider text-brand-purple font-semibold">
                Soros 종합
              </span>
            </div>
            <p className="text-sm text-txt-primary leading-relaxed whitespace-pre-line">
              {data.narrative}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
