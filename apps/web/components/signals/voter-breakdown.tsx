import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Cpu,
  Globe,
  Info,
  Minus,
  ShieldCheck,
  Sparkles,
  Waves,
} from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { gradeToLabel, type SignalGrade } from '@/lib/signal-resolver';
import type { VoterBreakdown, VoterRow } from '@/lib/queries/voters';

// ─── Voter metadata ────────────────────────────────────────────────

interface VoterMeta {
  name: string;
  domain: string;
  philosophy: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  realName: string;
  era: string;
  bio: string;
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
      "워런 버핏의 스승. '내재가치 - 시장가격 = 안전마진' 개념을 정립.",
    inputs: ['forwardPE / trailingPE', 'PBR · ROE', '매출 · 영업이익 YoY (5분기 평균)'],
  },
  dow: {
    name: 'Dow', domain: '추세', philosophy: '이평선 정렬 · 모멘텀',
    icon: Activity, accent: '#5B8DEF',
    realName: 'Charles Dow (1851–1902)',
    era: '월스트리트 저널 창립자 · 다우 이론',
    bio:
      "월스트리트 저널과 다우존스 지수의 창립자. '추세는 친구다' 격언의 시초. " +
      "다우 이론(주추세·중기·단기 3축)으로 시장 방향성 모델 정립.",
    inputs: ['200일/60일/20일 이평선 정렬', '거래량 5일 vs 20일 비율', '52주 신고가 근접도'],
  },
  turing: {
    name: 'Turing', domain: '기술', philosophy: 'RSI · MACD · Bollinger',
    icon: Cpu, accent: '#A06CD5',
    realName: 'Alan Turing (1912–1954)',
    era: '컴퓨터 과학 · 기계학습의 시조',
    bio:
      '암호 해독(에니그마)과 보편 튜링 기계로 알고리즘 가능성을 정의. ' +
      "'패턴은 수치로 환원된다'는 관점을 따라 순수 기술지표만 사용.",
    inputs: ['RSI(14) 과매수/과매도', 'MACD(12,26,9) 크로스오버', 'Bollinger %b(20, 2σ)'],
  },
  shiller: {
    name: 'Shiller', domain: '사이클', philosophy: 'CAPE · 매출 추세',
    icon: Waves, accent: '#3DA88C',
    realName: 'Robert Shiller (1946– )',
    era: '예일대 · 노벨 경제학상(2013)',
    bio:
      '《Irrational Exuberance》(2000)에서 닷컴 버블 경고. ' +
      'CAPE(10년 평균 수익 기반 PER) 지표 창안. ' +
      '시장이 군중 심리에 의해 왜곡된다는 입장.',
    inputs: ['forwardPE vs 섹터 중앙값', '매출 추세 5분기 회귀', '시장 regime'],
  },
  keynes: {
    name: 'Keynes', domain: '거시', philosophy: 'USD · 금리 · VIX · WTI · DXY',
    icon: Globe, accent: '#E59B47',
    realName: 'John Maynard Keynes (1883–1946)',
    era: '거시경제학의 창시자 · 펀드매니저',
    bio:
      '《일반이론》(1936) 저자. 정부 재정정책의 효과를 이론화. ' +
      "King's College Cambridge 펀드 매니저로 영국채·환율·원자재 활용.",
    inputs: ['USDKRW · ^TNX · ^VIX · DXY · WTI', '종목별 5개 매크로 베타', '5요소 합산 기대 변동 %p'],
  },
  taleb: {
    name: 'Taleb', domain: '리스크', philosophy: '꼬리위험 · 이벤트',
    icon: AlertTriangle, accent: '#D85A6A',
    realName: 'Nassim Nicholas Taleb (1960– )',
    era: '《블랙스완》 · 안티프래질',
    bio:
      '《Fooled by Randomness》(2001), 《The Black Swan》(2007) 저자. ' +
      '정규분포가 무시하는 꼬리 사건이 시장 손익의 본질이라는 입장. ' +
      'severity 1-5 등급 + 자동 강등으로 강세 신호에 brake를 검.',
    inputs: ['90일 최대 drawdown', '90일 변동성 (연환산)', '비대칭 비율', 'D-7 earnings 임박'],
  },
  simons: {
    name: 'Simons', domain: 'ML', philosophy: 'GBM · 패턴 학습',
    icon: BarChart3, accent: '#6BB6FF',
    realName: 'James Simons (1938–2024)',
    era: 'Renaissance Technologies · Medallion',
    bio:
      "수학자에서 헤지펀드 매니저로 전향. Medallion 펀드 30년간 연 66% 수익. " +
      "'데이터로 패턴만 찾는다' 입장으로 순수 ML 분류기.",
    inputs: ['14개 피처 (기술+매크로+뉴스)', 'GradientBoosting · 캘리브레이션', 'GroupKFold 시계열 검증'],
  },
};

// ─── Color + verdict utilities ─────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 1.0)   return 'rgb(72,166,152)';   // green/success
  if (score >= 0.3)   return '#7CC97E';            // light green
  if (score >= -0.3)  return 'rgb(170,170,170)';   // grey/neutral
  if (score >= -1.0)  return '#E9B247';            // amber
  return 'rgb(220,72,72)';                          // red
}

function scoreVerdict(score: number): string {
  if (score >= 1.5)   return '강한 긍정';
  if (score >= 0.5)   return '긍정';
  if (score >= -0.5)  return '중립';
  if (score >= -1.5)  return '부정';
  return '강한 부정';
}

function scoreIcon(score: number) {
  if (score >= 0.5) return ArrowUp;
  if (score <= -0.5) return ArrowDown;
  return Minus;
}

// ─── Voter distribution (horizontal bars per voter) ────────────────

/** One-line-per-voter bipolar bars. Replaces the previous vertical
 *  spectrum bars — horizontal is much easier to scan at a glance and
 *  carries verdict + name + score on each row. */
function VoterDistribution({ voters }: { voters: VoterRow[] }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <div className="h-px flex-1 bg-border-default/40" />
        <span className="text-[10px] uppercase tracking-[0.15em] text-txt-muted font-semibold">
          voter 분포
        </span>
        <div className="h-px flex-1 bg-border-default/40" />
      </div>
      <div className="space-y-1.5">
        {voters.map((v) => {
          const meta = VOTER_META[v.agent_name];
          if (!meta) return null;
          const color = scoreColor(v.score);
          const verdict = scoreVerdict(v.score);
          const Trend = scoreIcon(v.score);
          const barPct = Math.min(100, (Math.abs(v.score) / 2) * 50);
          return (
            <div
              key={v.agent_name}
              className="flex items-center gap-3 px-3 py-1.5 rounded-sm hover:bg-bg-secondary/30 transition-colors"
            >
              <div className="w-20 text-xs font-semibold tabular-nums" style={{ color: meta.accent }}>
                {meta.name}
              </div>
              <div className="text-[10px] text-txt-muted w-14 truncate" title={meta.philosophy}>
                {meta.domain}
              </div>
              <div className="flex-1 relative h-2 rounded-full bg-bg-tertiary/30 overflow-hidden">
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border-default/50" />
                <div
                  className={cn(
                    'absolute top-0 bottom-0 rounded-full transition-all',
                    v.score >= 0 ? 'left-1/2' : 'right-1/2',
                  )}
                  style={{ width: `${barPct}%`, background: color }}
                />
              </div>
              <div
                className="flex items-center gap-1 text-xs font-mono tabular-nums w-16 justify-end"
                style={{ color }}
              >
                <Trend className="h-3 w-3 shrink-0" />
                <span className="font-semibold">
                  {v.score >= 0 ? '+' : ''}
                  {v.score.toFixed(2)}
                </span>
              </div>
              <div
                className="text-[10px] w-14 text-right font-medium"
                style={{ color }}
              >
                {verdict}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Voter card with hover bio ─────────────────────────────────────

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
    <div className="rounded-lg border border-border-subtle/50 bg-bg-secondary/30 p-3.5 hover:border-border-default/70 hover:bg-bg-secondary/50 transition-all">
      {/* Header row: avatar + name + weight */}
      <div className="flex items-start gap-3 mb-2.5">
        <div className="relative shrink-0 group/avatar">
          <button
            type="button"
            aria-label={`${meta.name} 프로필`}
            className="h-10 w-10 rounded-full flex items-center justify-center transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-brand-purple/50"
            style={{
              background: `${meta.accent}1F`,
              color: meta.accent,
              border: `1px solid ${meta.accent}40`,
            }}
          >
            <Icon className="h-4 w-4" />
          </button>
          {/* Bio popover */}
          <div
            className="absolute left-0 top-full mt-1.5 z-40 w-80 rounded-lg border border-border-default bg-bg-secondary p-3.5 shadow-xl opacity-0 invisible group-hover/avatar:opacity-100 group-hover/avatar:visible group-focus-within/avatar:opacity-100 group-focus-within/avatar:visible transition-all duration-150 pointer-events-none"
            role="tooltip"
          >
            <div className="flex items-center gap-2 mb-2">
              <div
                className="h-6 w-6 rounded-full flex items-center justify-center shrink-0"
                style={{ background: `${meta.accent}1F`, color: meta.accent }}
              >
                <Icon className="h-3 w-3" />
              </div>
              <div>
                <div className="text-xs font-semibold" style={{ color: meta.accent }}>
                  {meta.realName}
                </div>
                <div className="text-[9px] uppercase tracking-wider text-txt-muted">
                  {meta.era}
                </div>
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-txt-primary mb-2.5">
              {meta.bio}
            </p>
            <div className="border-t border-border-subtle pt-2">
              <div className="text-[9px] uppercase tracking-wider text-txt-muted mb-1 font-semibold">
                사용 데이터
              </div>
              <ul className="text-[11px] text-txt-secondary space-y-0.5">
                {meta.inputs.map((input) => (
                  <li key={input} className="flex gap-1.5">
                    <span style={{ color: meta.accent }}>▸</span>
                    <span>{input}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="font-semibold text-base text-txt-primary">{meta.name}</span>
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ background: `${meta.accent}1F`, color: meta.accent }}
            >
              {meta.domain}
            </span>
          </div>
          <div className="text-[11px] text-txt-muted truncate" title={meta.philosophy}>
            {meta.philosophy}
          </div>
        </div>
        {weight != null && (
          <span className="text-[11px] text-txt-muted tabular-nums shrink-0 mt-1">
            w {Math.round(weight * 100)}%
          </span>
        )}
      </div>

      {/* Score + verdict + bar */}
      <div className="flex items-baseline justify-between mb-2">
        <span
          className="text-[11px] uppercase tracking-[0.15em] font-bold"
          style={{ color }}
        >
          {verdict}
        </span>
        <span
          className="font-mono tabular-nums text-xl font-bold"
          style={{ color }}
        >
          {voter.score >= 0 ? '+' : ''}
          {voter.score.toFixed(2)}
        </span>
      </div>

      <div className="relative h-1.5 rounded-full bg-bg-tertiary/40 overflow-hidden mb-2.5">
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border-default/60" />
        <div
          className={cn(
            'absolute top-0 bottom-0 rounded-full transition-all',
            voter.score >= 0 ? 'left-1/2' : 'right-1/2',
          )}
          style={{ width: `${barPct}%`, background: color }}
        />
      </div>

      {voter.narrative && (
        <p
          className="text-[13px] text-txt-secondary line-clamp-4 leading-relaxed"
          title={voter.narrative}
        >
          {voter.narrative}
        </p>
      )}
    </div>
  );
}

// ─── Soros synthesis — parse into structured sections ──────────────

interface ParsedSoros {
  headline: string | null;
  body: string;
}

/** Lightweight parse of the Soros narrative.
 *  The LLM produces one long Korean paragraph ending with a conclusion
 *  sentence like '...최종 시그널은 HOLD.'. We extract that last sentence
 *  as the headline and keep the rest as the body, formatted with
 *  inline line breaks at sentence boundaries. */
function parseSoros(narrative: string): ParsedSoros {
  const trimmed = narrative.trim();
  // Split on '.' followed by space or end; keep the dot.
  const sentences = trimmed
    .split(/(?<=[\.\!\?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length <= 1) {
    return { headline: null, body: trimmed };
  }
  // Pick the LAST sentence that contains a grade keyword as the headline;
  // fall back to the last sentence overall.
  const gradeKeywords = ['HOLD', 'BUY', 'CAUTION', 'RISK', '시그널은', '최종'];
  let headlineIdx = sentences.length - 1;
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (gradeKeywords.some((kw) => sentences[i].includes(kw))) {
      headlineIdx = i;
      break;
    }
  }
  const headline = sentences[headlineIdx];
  const body = sentences
    .filter((_, idx) => idx !== headlineIdx)
    .join(' ');
  return { headline, body };
}

function SorosSynthesis({ narrative }: { narrative: string }) {
  const { headline, body } = parseSoros(narrative);
  return (
    <section className="rounded-lg border border-brand-purple/30 bg-gradient-to-br from-brand-purple/5 via-brand-purple/3 to-transparent overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-brand-purple/20 bg-brand-purple/5">
        <div className="h-7 w-7 rounded-full bg-gradient-brand flex items-center justify-center shrink-0">
          <Sparkles className="h-3.5 w-3.5 text-white" />
        </div>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-[0.15em] text-brand-purple font-bold">
            Soros 종합
          </div>
          <div className="text-[10px] text-txt-muted">
            5인 voter 의견 + priced_in + Taleb 게이트의 메타 분석
          </div>
        </div>
      </div>

      {/* Headline (extracted final-grade conclusion) */}
      {headline && (
        <div className="px-4 pt-3.5">
          <div className="flex gap-2 text-sm font-medium text-brand-purple leading-relaxed">
            <span className="shrink-0">▍</span>
            <span>{headline}</span>
          </div>
        </div>
      )}

      {/* Body — main analysis with comfortable typography */}
      {body && (
        <div className="px-4 py-3.5 text-sm text-txt-primary leading-relaxed">
          {body}
        </div>
      )}
    </section>
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

  const confTone =
    confPct == null
      ? 'text-txt-muted'
      : confPct < 50
        ? 'text-status-warning'
        : confPct >= 70
          ? 'text-status-success'
          : 'text-txt-primary';

  const gradeAccent =
    grade === 'STRONG_BUY' ? 'rgb(72,166,152)'
    : grade === 'BUY'      ? '#7CC97E'
    : grade === 'HOLD'     ? 'rgb(170,170,170)'
    : grade === 'CAUTION'  ? '#E9B247'
    :                        'rgb(220,72,72)';

  // Status text under the agreement number — explains what 4% means.
  const consensusNote = (() => {
    if (confPct == null) return null;
    if (activeCount <= 1) return '단일 voter 주도';
    if (confPct < 30) return 'voter 의견 충돌';
    if (confPct < 50) return '의견 분산';
    if (confPct < 70) return '약한 동의';
    return '강한 합의';
  })();

  return (
    <Card className="border-brand-purple/20 relative">
      {/* Accent stripe — grade color at the top edge */}
      <div
        className="absolute top-0 left-0 right-0 h-1 rounded-t-lg pointer-events-none"
        style={{ background: gradeAccent }}
      />

      <CardContent className="pt-6 pb-5 space-y-5">
        {/* ── Heading row ───────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-heading font-semibold flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-gradient-brand" />
            6-Voter 합의
          </h2>
          <div className="flex items-center gap-2 text-[11px] text-txt-muted">
            <span>
              cycle{' '}
              <span className="font-mono">
                {data.cycle_at.slice(0, 16).replace('T', ' ')}
              </span>
            </span>
            {data.taleb_override && (
              <Badge variant="outline" className="border-status-danger/40 text-status-danger">
                Taleb sev {data.taleb_severity}
              </Badge>
            )}
            {(weights as Record<string, unknown>)['confidence_gate_applied'] === true && (
              <Badge variant="outline" className="border-status-warning/40 text-status-warning">
                신뢰도 게이트
              </Badge>
            )}
          </div>
        </div>

        {/* ── Hero verdict block ────────────────────────────────── */}
        <div className="rounded-lg border border-border-subtle/60 bg-bg-secondary/30 px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-12 items-center">
            {/* Grade — primary visual anchor */}
            <div className="sm:col-span-4">
              <div className="text-[10px] uppercase tracking-[0.15em] text-txt-muted mb-1 font-semibold">
                최종 등급
              </div>
              <div
                className="text-3xl font-bold leading-none mb-1.5"
                style={{ color: gradeAccent }}
              >
                {label}
              </div>
              {strengthPct !== null && (
                <div className="flex items-baseline gap-1.5 text-[11px]">
                  <span className="text-txt-muted">방향 강도</span>
                  <span className="font-mono tabular-nums font-semibold text-txt-primary">
                    {strengthPct}
                  </span>
                  <span className="text-txt-muted">/100</span>
                </div>
              )}
            </div>

            {/* Vertical divider */}
            <div className="hidden sm:block sm:col-span-1">
              <div className="h-16 w-px bg-border-default/40 mx-auto" />
            </div>

            {/* Score breakdown */}
            <div className="sm:col-span-3">
              <div className="text-[10px] uppercase tracking-[0.15em] text-txt-muted mb-1 font-semibold">
                가중 점수
              </div>
              <div className="text-2xl font-mono tabular-nums font-bold leading-none mb-1.5">
                {weightedScore != null ? (
                  <>
                    <span style={{ color: gradeAccent }}>
                      {weightedScore >= 0 ? '+' : ''}
                      {weightedScore.toFixed(2)}
                    </span>
                  </>
                ) : (
                  '—'
                )}
              </div>
              <div className="text-[11px] text-txt-muted">
                정규화 범위 -2 ~ +2
              </div>
            </div>

            {/* Vertical divider */}
            <div className="hidden sm:block sm:col-span-1">
              <div className="h-16 w-px bg-border-default/40 mx-auto" />
            </div>

            {/* Confidence */}
            <div className="sm:col-span-3">
              <div className="text-[10px] uppercase tracking-[0.15em] text-txt-muted mb-1 font-semibold">
                voter 합의
              </div>
              <div className={cn('text-2xl font-bold leading-none mb-1.5', confTone)}>
                {confPct != null ? `${confPct}%` : '—'}
              </div>
              <div className="text-[11px] text-txt-muted flex items-baseline gap-1.5">
                <span className="font-mono tabular-nums">
                  active {activeCount}/{data.voters.length}
                </span>
                {consensusNote && (
                  <span className={confTone}>· {consensusNote}</span>
                )}
              </div>
            </div>
          </div>

          {/* Low-confidence warning — embedded inside the hero block */}
          {confPct != null && confPct < 50 && (
            <div className="mt-3.5 pt-3 border-t border-border-subtle/40 flex items-start gap-2 text-xs text-status-warning">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <div className="leading-relaxed">
                voter 의견이 분산되어 있습니다. 단일 voter가 신호를 주도하므로
                <strong> 등급 강등</strong>이 적용되었을 수 있으며 다음 사이클에서
                합의가 강해지는지 확인을 권장합니다.
              </div>
            </div>
          )}
        </div>

        {/* ── Voter distribution (horizontal bars) ──────────────── */}
        <VoterDistribution voters={data.voters} />

        {/* ── Voter cards grid ─────────────────────────────────── */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <div className="h-px flex-1 bg-border-default/40" />
            <span className="text-[10px] uppercase tracking-[0.15em] text-txt-muted font-semibold">
              분석가 의견
            </span>
            <div className="h-px flex-1 bg-border-default/40" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.voters.map((v) => (
              <VoterCard
                key={v.agent_name}
                voter={v}
                weight={weights[v.agent_name] as number | undefined}
              />
            ))}
          </div>
        </section>

        {/* ── Soros synthesis — structured ─────────────────────── */}
        {data.narrative && <SorosSynthesis narrative={data.narrative} />}
      </CardContent>
    </Card>
  );
}
