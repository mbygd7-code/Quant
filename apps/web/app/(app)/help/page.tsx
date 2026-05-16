import Link from 'next/link';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Brain,
  CandlestickChart,
  CheckCircle2,
  ChevronRight,
  Eye,
  Flame,
  Gauge,
  KeyRound,
  LineChart,
  MousePointerSquareDashed,
  Scale,
  Sigma,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
  Waves,
} from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// Help page for absolute beginners. Goal: a single page that explains
// every term, abbreviation, chart element, and AI concept the app
// surfaces. Big icons + big readable text + practical "어떻게 활용?"
// blurbs that translate the concept into a trading move (without
// crossing into recommendation territory — per CLAUDE.md absolute rules).

export const metadata = {
  title: '도움말 — 주식 시작 가이드',
  description: '주식 용어, 차트, 거래량, AI 시그널을 처음 보는 분도 쉽게 이해할 수 있도록 정리했어요',
};

export default function HelpPage() {
  return (
    <div className="space-y-8 max-w-[1100px] mx-auto pb-16">
      {/* ─── HERO ─────────────────────────────────────── */}
      <section className="rounded-2xl border-2 border-brand-purple/30 bg-gradient-to-br from-brand-purple/[0.08] via-bg-secondary to-bg-secondary p-8 md:p-10 shadow-md">
        <div className="flex items-start gap-5">
          <div className="rounded-2xl bg-brand-purple/15 p-4 hidden md:block">
            <Sparkles className="h-10 w-10 text-brand-purple" />
          </div>
          <div className="flex-1">
            <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-txt-primary leading-tight">
              주식, 처음부터 차근차근
            </h1>
            <p className="mt-3 text-lg md:text-xl text-txt-secondary leading-relaxed">
              이 페이지 하나면 충분해요. 차트 보는 법부터, 매수·매도 결정에 도움되는
              지표, AI가 내놓는 5단계 신호까지 — 한 자리에서 정리했습니다.
            </p>
            <p className="mt-4 text-sm text-txt-muted">
              ⓘ 본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다. 모든 결정은 본인 책임입니다.
            </p>
          </div>
        </div>
      </section>

      {/* ─── TOC ──────────────────────────────────────── */}
      <nav className="grid grid-cols-2 md:grid-cols-4 gap-3" aria-label="목차">
        {TOC.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className="flex items-center gap-2.5 rounded-xl border-2 border-border-subtle/60 bg-bg-secondary px-3.5 py-3 hover:border-brand-purple/40 hover:bg-brand-purple/[0.04] transition-colors"
          >
            <item.icon className="h-5 w-5 text-brand-purple shrink-0" />
            <span className="text-[15px] font-semibold text-txt-primary">
              {item.label}
            </span>
          </a>
        ))}
      </nav>

      {/* ─── 1. 기본 용어 ─────────────────────────────── */}
      <Section id="basics" icon={Sigma} title="1. 가장 먼저 알아야 할 용어" subtitle="이 단어들만 알면 차트의 80%가 읽혀요">
        <div className="grid md:grid-cols-2 gap-5">
          <TermCard
            icon={ArrowUpRight}
            iconColor="#F26D6D"
            title="시가 / 종가"
            short="O / C"
            body="시가는 그날 거래가 시작될 때의 가격, 종가는 마감 때 가격. 한국 시장 기준 09:00 시작 → 15:30 종료."
            usage="종가가 시가보다 높으면 '오른 날'(빨강), 낮으면 '내린 날'(파랑). 한국 시장은 빨강이 상승, 파랑이 하락이에요. 미국은 반대 (초록 상승, 빨강 하락)."
          />
          <TermCard
            icon={Target}
            iconColor="#48A698"
            title="고가 / 저가"
            short="H / L"
            body="그날 도달한 가장 높은 가격과 가장 낮은 가격. 캔들봉의 위·아래 가느다란 선(꼬리)이 이것을 표시해요."
            usage="고가-저가 차이가 크면 그날 변동성이 큰 날. 작으면 박스권에서 움직인 잔잔한 날."
          />
          <TermCard
            icon={BarChart3}
            iconColor="#5BA8F2"
            title="거래량 (Volume)"
            short="V"
            body="그날 거래된 주식의 수. 100만 = 100만 주가 손바뀜 했다는 뜻."
            usage="가격이 올랐을 때 거래량도 큼 = '진짜 추세'. 가격은 올랐는데 거래량 작음 = '의심해야 할 상승'. 거래량은 가격의 '신뢰도'예요."
          />
          <TermCard
            icon={TrendingUp}
            iconColor="#A855F7"
            title="등락률 (%)"
            short="±%"
            body="(현재가 − 전일 종가) ÷ 전일 종가 × 100. '오늘 얼마나 변했나'를 한 줄로 표현."
            usage="+5% 이상이면 강한 상승, ±1% 이하면 잔잔한 날. 한국 시장 ±30%가 일일 상한선(상하한가)."
          />
        </div>
      </Section>

      {/* ─── 2. 캔들봉 ───────────────────────────────── */}
      <Section id="candles" icon={CandlestickChart} title="2. 캔들봉 (Candlestick) 읽기" subtitle="200년 된 일본 쌀 시장에서 시작된 가격 표시 방식">
        <div className="rounded-2xl border-2 border-border-subtle/60 bg-bg-secondary p-6 md:p-8">
          <div className="grid md:grid-cols-2 gap-8 items-center">
            <div className="flex justify-center">
              <CandleDiagram />
            </div>
            <div className="space-y-4">
              <p className="text-lg text-txt-primary leading-relaxed">
                캔들봉 하나는 <strong>하루(또는 한 시간)의 가격 4가지</strong>를 한꺼번에 보여줘요.
              </p>
              <ul className="space-y-3 text-[15px] text-txt-secondary">
                <li className="flex items-start gap-2.5">
                  <span className="inline-block w-2 h-2 rounded-full mt-2" style={{ background: '#F26D6D' }} />
                  <span><strong className="text-txt-primary">몸통(Body)</strong> — 시가↔종가 사이. 빨강이면 종가가 더 높음(상승), 파랑이면 종가가 더 낮음(하락).</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="inline-block w-2 h-2 rounded-full mt-2" style={{ background: 'var(--text-secondary)' }} />
                  <span><strong className="text-txt-primary">꼬리(Wick)</strong> — 몸통 위·아래로 뻗은 가는 선. 위 꼬리 = 고가, 아래 꼬리 = 저가.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="inline-block w-2 h-2 rounded-full mt-2" style={{ background: '#48A698' }} />
                  <span><strong className="text-txt-primary">긴 위 꼬리</strong> — "올렸다가 떨어뜨림" = 위에서 누가 팔았다는 신호.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="inline-block w-2 h-2 rounded-full mt-2" style={{ background: '#5BA8F2' }} />
                  <span><strong className="text-txt-primary">긴 아래 꼬리</strong> — "떨어뜨렸다가 끌어올림" = 아래서 누가 샀다는 신호.</span>
                </li>
              </ul>
              <div className="rounded-lg bg-status-info/[0.08] border border-status-info/30 p-4 text-[14px] text-txt-secondary">
                <strong className="text-status-info block mb-1">💡 활용 팁</strong>
                긴 꼬리는 '저항/지지'를 보여줘요. 같은 가격대에서 긴 위 꼬리가 여러 개 = 그 가격이 강한 저항선.
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* ─── 3. 차트 도구 ─────────────────────────────── */}
      <Section id="chart-tools" icon={LineChart} title="3. 차트의 보조선들" subtitle="가격만 봐도 알기 어려운 추세·과열·정상범위를 그려줘요">
        <div className="grid md:grid-cols-2 gap-5">
          <TermCard
            icon={Waves}
            iconColor="#F59E0B"
            title="MA (이동평균선)"
            short="MA5 · 20 · 60 · 120"
            body="최근 N일 종가의 평균을 잇는 선. MA20 = 20일 평균 가격선. 가격이 들쭉날쭉해도 '추세'를 부드럽게 보여줘요."
            usage="MA20 위에 있으면 단기 상승세, 아래면 단기 하락세. MA20이 MA60을 위로 뚫으면(골든크로스) 추세 전환 신호로 봐요. 반대는 데드크로스."
          />
          <TermCard
            icon={Scale}
            iconColor="#A855F7"
            title="Bollinger Bands"
            short="BB ±2σ"
            body="MA20에서 위·아래로 표준편차 2배만큼 띠를 그어요. 가격이 보통 이 안에서 움직여요."
            usage="위쪽 띠 닿으면 '과열', 아래쪽 띠 닿으면 '과매도'. 띠가 좁아지면 '곧 큰 변동이 온다'는 신호 (변동성 축소 → 폭발)."
          />
          <TermCard
            icon={Gauge}
            iconColor="#A855F7"
            title="RSI (상대강도지수)"
            short="RSI(14)"
            body="0~100 사이 숫자. 최근 14일 동안 오른 폭과 내린 폭의 비율을 계산해요."
            usage="70 이상 = 과매수(곧 조정 가능성), 30 이하 = 과매도(반등 가능성). 50 근처면 중립. 가격은 신고가인데 RSI는 못 따라오면 '하락 다이버전스' = 위험 신호."
          />
          <TermCard
            icon={TrendingDown}
            iconColor="#A855F7"
            title="OBV (누적 매수/매도)"
            short="OBV"
            body="오른 날 거래량은 +, 내린 날 거래량은 −로 더해가는 그래프. 1963년 Granville이 만든 고전 지표."
            usage="가격은 횡보인데 OBV가 오름 = 숨은 매집(곧 상승 가능). 가격은 신고가인데 OBV는 안 따라옴 = 분배(고점 의심)."
          />
        </div>
      </Section>

      {/* ─── 4. 거래량 ───────────────────────────────── */}
      <Section id="volume" icon={BarChart3} title="4. 거래량 페인 — 왜 따로 보나요?" subtitle="가격만큼 중요한 두 번째 축">
        <div className="rounded-2xl border-2 border-border-subtle/60 bg-bg-secondary p-6 md:p-8 space-y-5">
          <p className="text-[17px] text-txt-primary leading-relaxed">
            가격이 <strong>"누군가가 사고 누군가가 팔아서"</strong> 만들어지는데,
            거래량은 <strong>"얼마나 많은 사람이 거래했나"</strong>를 보여줘요.
            가격 변동을 확인하는 '확신도 메터'입니다.
          </p>

          <div className="grid md:grid-cols-3 gap-4">
            <div className="rounded-lg bg-status-success/[0.08] border-2 border-status-success/30 p-4">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="h-5 w-5 text-status-success" />
                <strong className="text-status-success text-[15px]">강한 추세</strong>
              </div>
              <p className="text-[14px] text-txt-secondary leading-relaxed">
                가격 ↑ + 거래량 ↑↑ = 많은 사람이 동참한 진짜 상승
              </p>
            </div>
            <div className="rounded-lg bg-status-warning/[0.08] border-2 border-status-warning/30 p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="h-5 w-5 text-status-warning" />
                <strong className="text-status-warning text-[15px]">의심해야 할 상승</strong>
              </div>
              <p className="text-[14px] text-txt-secondary leading-relaxed">
                가격 ↑ + 거래량 ↓ = 소수만 끌고 가는 약한 상승, 곧 되돌릴 위험
              </p>
            </div>
            <div className="rounded-lg bg-status-danger/[0.08] border-2 border-status-danger/30 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Flame className="h-5 w-5 text-status-danger" />
                <strong className="text-status-danger text-[15px]">분배 의심</strong>
              </div>
              <p className="text-[14px] text-txt-secondary leading-relaxed">
                고점에서 거래량 ↑↑ + 음봉 비율 ↑ = 큰손이 던지는 중일 수 있음
              </p>
            </div>
          </div>

          <div className="rounded-lg bg-bg-tertiary/40 border border-border-subtle/60 p-4 text-[14px] text-txt-secondary">
            <strong className="text-txt-primary block mb-1.5">📊 거래량 페인의 수치들</strong>
            <ul className="space-y-1 ml-4 list-disc">
              <li><strong>평균 거래량</strong> — 선택 기간의 평균. 비교 기준선.</li>
              <li><strong>상대 거래량 (1.21x)</strong> — 오늘이 평균 대비 몇 배. 1.5배 이상이면 이례적.</li>
              <li><strong>매수/매도 %</strong> — 상승일 거래량 비중 vs 하락일. 60% 이상 한쪽이면 분명한 우위.</li>
              <li><strong>OBV Δ</strong> — 기간 누적 매집/분배. 양수면 사들이는 중.</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ─── 5. AI 5단계 신호 ─────────────────────────── */}
      <Section id="signals" icon={Brain} title="5. AI 5단계 신호" subtitle="이 서비스의 핵심 — 종목 하나하나에 매일 부여하는 등급">
        <div className="space-y-3">
          {SIGNAL_TIERS.map((tier) => (
            <div
              key={tier.label}
              className="flex items-center gap-4 rounded-xl border-2 p-4 md:p-5"
              style={{ borderColor: `${tier.color}55`, background: `${tier.color}0D` }}
            >
              <div
                className="flex items-center justify-center rounded-full w-14 h-14 md:w-16 md:h-16 shrink-0 text-2xl md:text-3xl"
                style={{ background: tier.color, color: '#fff' }}
                aria-hidden
              >
                <tier.icon className="h-7 w-7 md:h-8 md:w-8" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <h3 className="text-xl md:text-2xl font-bold" style={{ color: tier.color }}>
                    {tier.label}
                  </h3>
                  <span className="text-sm text-txt-muted font-mono">
                    종합점수 {tier.range}
                  </span>
                </div>
                <p className="mt-1 text-[15px] text-txt-secondary leading-relaxed">
                  {tier.body}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-lg bg-status-warning/[0.08] border border-status-warning/30 p-4 text-[14px] text-txt-secondary leading-relaxed">
          <strong className="text-status-warning block mb-1">⚠ 신뢰도 함께 보기</strong>
          신호가 "강한 관심"이라도 신뢰도가 낮으면 (50점 미만) 데이터가 부족하거나 모델이 평균 회귀 중이에요.
          신호 옆 신뢰도 배지(높음/보통/낮음)를 반드시 함께 확인하세요.
        </div>
      </Section>

      {/* ─── 6. 6명의 전문가 ──────────────────────────── */}
      <Section id="voters" icon={Users} title="6. AI 퀀트 6인 전문가" subtitle="역사적 투자 거장 6명의 관점을 코드로 재현 — 다수결로 합의 도출">
        <div className="grid md:grid-cols-2 gap-4">
          {VOTERS.map((v) => (
            <div key={v.name} className="rounded-xl border-2 border-border-subtle/60 bg-bg-secondary p-5">
              <div className="flex items-start gap-3 mb-2">
                <div
                  className="flex items-center justify-center rounded-lg w-11 h-11 shrink-0 text-lg font-bold"
                  style={{ background: `${v.color}22`, color: v.color }}
                >
                  {v.emoji}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg font-bold text-txt-primary">{v.name}</h3>
                  <p className="text-[12px] text-txt-muted">{v.style}</p>
                </div>
              </div>
              <p className="text-[14px] text-txt-secondary leading-relaxed">
                {v.body}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-lg bg-brand-purple/[0.06] border border-brand-purple/30 p-4 text-[14px] text-txt-secondary leading-relaxed">
          <strong className="text-brand-purple block mb-1">🧠 Soros 종합</strong>
          마지막에 <strong>Soros</strong>(소로스) 캐릭터가 6명 의견을 종합해서 최종 narrative + 단기/중기 전망 + 촉매·리스크를 정리해요.
        </div>
      </Section>

      {/* ─── 7. 정확도 지표 ──────────────────────────── */}
      <Section id="accuracy" icon={Target} title="7. 예측 정확도 읽는 법" subtitle="모델이 얼마나 믿을 만한지 정량화한 4개 지표">
        <div className="grid md:grid-cols-2 gap-5">
          <TermCard
            icon={Sigma}
            iconColor="#48A698"
            title="MAE / MAPE"
            short="평균 오차"
            body="MAE = 실측 ↔ 예측 차이의 절댓값 평균. MAPE = 그걸 비율(%)로. 0에 가까울수록 정확."
            usage="MAE 0.05 = 평균 5점(0~100 스케일)빗나감 = 우수. 10% MAPE 이하면 ✓, 30% 넘으면 ✗."
          />
          <TermCard
            icon={Gauge}
            iconColor="#A855F7"
            title="방향 일치 %"
            short="Direction"
            body="day-over-day 변동의 부호(↑/↓)가 일치한 비율. 50%는 동전 던지기 수준."
            usage="60% 이상이면 의미 있는 모델. 50% 미만이면 그냥 어제값 쓰는 게 나음."
          />
          <TermCard
            icon={Sparkles}
            iconColor="#F59E0B"
            title="skill +N%"
            short="Skill Score"
            body="naive baseline(='내일 = 오늘') 대비 얼마나 우수한가. 1 − (모델MAE / naiveMAE)."
            usage="양수면 모델이 가치 있음. 음수면 단순 예측보다 못한 무용 모델."
          />
          <TermCard
            icon={CheckCircle2}
            iconColor="#48A698"
            title="신뢰도 (높음/보통/낮음)"
            short="0~100"
            body="샘플량(30%) + MAPE(35%) + 방향일치(35%) 가중합."
            usage="70+ 높음 — 참고할만, 50~69 보통 — 다른 근거 같이 보기, < 50 낮음 — 데이터 부족."
          />
        </div>
      </Section>

      {/* ─── 8. 차트 단축키 ──────────────────────────── */}
      <Section id="shortcuts" icon={KeyRound} title="8. 차트 단축키 · 도구" subtitle="전문가처럼 빠르게 분석">
        <div className="space-y-3">
          <ShortcutCard
            icon={KeyRound}
            keyHint="Space"
            title="호버 창 확장"
            body="차트에 마우스 올린 상태에서 Space를 누르고 있으면 디테일 호버 창(영웅 종가 + 모든 지표)이 펼쳐져요. 떼면 다시 컴팩트로."
          />
          <ShortcutCard
            icon={MousePointerSquareDashed}
            keyHint="클릭+드래그"
            title="구간 측정"
            body="가격 차트 위에서 마우스 클릭+드래그 → 보라 사각형이 영역 표시. 봉 개수, 가격 변동(₩, %), 구간 H/L을 자동 계산해서 상단에 표시."
          />
          <ShortcutCard
            icon={Eye}
            keyHint="Esc"
            title="측정 영역 해제"
            body="드래그로 그린 사각형 측정 영역을 Esc 키로 즉시 해제."
          />
          <ShortcutCard
            icon={LineChart}
            keyHint="S · M · L · XL"
            title="거래량 페인 크기"
            body="거래량 페인에 마우스 호버 → 가운데 상단에 S/M/L/XL 버튼. S=기본 막대만, L=OBV 라인까지, XL=모든 지표. 페인 위 경계를 드래그해도 됨."
          />
        </div>
      </Section>

      {/* ─── 9. 실전 적용 ─────────────────────────────── */}
      <Section id="apply" icon={Sparkles} title="9. 모든 것을 종합해서 결정하기" subtitle="이 서비스를 실제로 어떻게 활용할까?">
        <div className="rounded-2xl border-2 border-brand-purple/30 bg-gradient-to-br from-brand-purple/[0.06] to-bg-secondary p-6 md:p-8 space-y-5">
          <p className="text-lg text-txt-primary leading-relaxed">
            <strong>한 가지 지표만 보고 결정하지 마세요.</strong> 신호·지표를 <strong>겹쳐서</strong> 봤을 때
            모두 같은 방향을 가리키면 그게 진짜 신호예요.
          </p>

          <ol className="space-y-3 text-[15px] text-txt-secondary leading-relaxed counter-reset list-decimal pl-6">
            <li><strong className="text-txt-primary">신호 확인</strong> — AI 5단계 신호가 '관심' 이상 + 신뢰도 '보통' 이상인지</li>
            <li><strong className="text-txt-primary">방향 점검</strong> — 캔들이 MA20 위에 있고 MA20이 우상향 중인지</li>
            <li><strong className="text-txt-primary">거래량 검증</strong> — 최근 상승일에 거래량이 평균 이상인지 (확신도)</li>
            <li><strong className="text-txt-primary">RSI 체크</strong> — 70 이하인지 (과열 회피)</li>
            <li><strong className="text-txt-primary">전문가 합의</strong> — 6 voters 중 4명 이상 같은 의견인지</li>
            <li><strong className="text-txt-primary">선행성 확인</strong> — 점수↔주가 상관도가 0.3 이상인지 (의미 있는 시그널)</li>
          </ol>

          <div className="rounded-lg bg-status-danger/[0.06] border-2 border-status-danger/30 p-4">
            <strong className="text-status-danger block mb-1.5">🚫 절대 금지</strong>
            <ul className="space-y-1 text-[14px] text-txt-secondary ml-4 list-disc">
              <li>한 종목에 자산 전부 — 분산은 무료 안전장치</li>
              <li>"단타로 빠르게" — 단기 예측 정확도는 늘 낮음</li>
              <li>신호 변경을 매일 추종 — 거래비용·세금이 수익을 갉아먹음</li>
              <li>SNS·유튜브 '확신'만 보고 진입 — 이 페이지의 모든 지표 함께 보기</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ─── Footer ───────────────────────────────────── */}
      <section className="rounded-xl border border-border-subtle/60 bg-bg-tertiary/30 p-5 text-center text-sm text-txt-muted">
        <p className="leading-relaxed">
          본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다.<br />
          모든 투자 결정과 결과는 본인 책임이며, 본 서비스는 손익에 대한 책임을 지지 않습니다.
        </p>
        <div className="mt-3 flex items-center justify-center gap-3 text-[13px]">
          <Link href="/dashboard" className="text-brand-purple hover:underline font-semibold inline-flex items-center gap-1">
            대시보드로 돌아가기
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </div>
  );
}

// ── Section helper ──────────────────────────────────────
function Section({
  id, icon: Icon, title, subtitle, children,
}: {
  id: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20">
      <div className="flex items-start gap-4 mb-5">
        <div className="rounded-xl bg-brand-purple/10 p-3 shrink-0">
          <Icon className="h-7 w-7 text-brand-purple" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl md:text-3xl font-extrabold text-txt-primary tracking-tight leading-tight">
            {title}
          </h2>
          <p className="mt-1 text-[15px] text-txt-secondary leading-relaxed">
            {subtitle}
          </p>
        </div>
      </div>
      {children}
    </section>
  );
}

function TermCard({
  icon: Icon, iconColor, title, short, body, usage,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  iconColor: string;
  title: string;
  short: string;
  body: string;
  usage: string;
}) {
  return (
    <div className="rounded-xl border-2 border-border-subtle/60 bg-bg-secondary p-5 hover:border-brand-purple/30 transition-colors">
      <div className="flex items-start gap-3 mb-3">
        <div
          className="rounded-lg p-2.5 shrink-0"
          style={{ background: `${iconColor}1F` }}
        >
          <Icon className="h-6 w-6" style={{ color: iconColor }} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-[18px] font-bold text-txt-primary">{title}</h3>
          <p className="text-[13px] font-mono text-txt-muted mt-0.5">{short}</p>
        </div>
      </div>
      <p className="text-[15px] text-txt-secondary leading-relaxed mb-3">
        {body}
      </p>
      <div className="rounded-md bg-bg-tertiary/50 border border-border-subtle/40 p-3 text-[13px] text-txt-secondary leading-relaxed">
        <strong className="text-txt-primary block mb-1">💡 활용</strong>
        {usage}
      </div>
    </div>
  );
}

function ShortcutCard({
  icon: Icon, keyHint, title, body,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  keyHint: string;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-4 rounded-xl border-2 border-border-subtle/60 bg-bg-secondary p-5">
      <div className="rounded-lg bg-brand-purple/10 p-3 shrink-0">
        <Icon className="h-6 w-6 text-brand-purple" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap mb-1">
          <h3 className="text-[17px] font-bold text-txt-primary">{title}</h3>
          <kbd className="px-2 py-0.5 text-[11px] font-mono font-bold rounded border-2 border-border-default bg-bg-tertiary text-txt-primary">
            {keyHint}
          </kbd>
        </div>
        <p className="text-[14px] text-txt-secondary leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

function CandleDiagram() {
  return (
    <svg width="180" height="240" viewBox="0 0 180 240" aria-hidden>
      {/* Up candle (red — KR convention) */}
      <g transform="translate(30, 20)">
        <line x1="20" y1="0" x2="20" y2="200" stroke="#F26D6D" strokeWidth="2.5" strokeLinecap="round" />
        <rect x="6" y="55" width="28" height="110" rx="3" fill="#F26D6D" stroke="#F26D6D" strokeWidth="1" />
        <text x="20" y="-6" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#F26D6D">상승</text>
        <text x="55" y="10" fontSize="10" fill="var(--text-muted)">고가</text>
        <line x1="40" y1="6" x2="35" y2="6" stroke="var(--text-muted)" />
        <text x="55" y="60" fontSize="10" fill="var(--text-muted)">종가</text>
        <line x1="40" y1="56" x2="35" y2="56" stroke="var(--text-muted)" />
        <text x="55" y="170" fontSize="10" fill="var(--text-muted)">시가</text>
        <line x1="40" y1="166" x2="35" y2="166" stroke="var(--text-muted)" />
        <text x="55" y="208" fontSize="10" fill="var(--text-muted)">저가</text>
        <line x1="40" y1="204" x2="35" y2="204" stroke="var(--text-muted)" />
      </g>
      {/* Down candle (blue — KR convention) */}
      <g transform="translate(115, 20)">
        <line x1="20" y1="0" x2="20" y2="200" stroke="#5BA8F2" strokeWidth="2.5" strokeLinecap="round" />
        <rect x="6" y="55" width="28" height="110" rx="3" fill="#5BA8F2" stroke="#5BA8F2" strokeWidth="1" />
        <text x="20" y="-6" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#5BA8F2">하락</text>
      </g>
    </svg>
  );
}

// ── Data ────────────────────────────────────────────────
const TOC = [
  { href: '#basics',    label: '기본 용어',      icon: Sigma },
  { href: '#candles',   label: '캔들봉',        icon: CandlestickChart },
  { href: '#chart-tools', label: '차트 도구',   icon: LineChart },
  { href: '#volume',    label: '거래량',        icon: BarChart3 },
  { href: '#signals',   label: 'AI 5단계 신호', icon: Brain },
  { href: '#voters',    label: '6 전문가',      icon: Users },
  { href: '#accuracy',  label: '정확도 지표',   icon: Target },
  { href: '#shortcuts', label: '단축키 · 도구', icon: KeyRound },
] as const;

const SIGNAL_TIERS = [
  {
    label: '강한 관심',
    range: '≥ 0.80',
    color: '#48A698',
    icon: TrendingUp,
    body: '여러 지표가 모두 긍정. 추세·거래량·전문가 합의 모두 우상향. 단, 신뢰도와 거시 환경 함께 확인 필요.',
  },
  {
    label: '관심',
    range: '0.65 ~ 0.80',
    color: '#7CC97E',
    icon: ArrowUpRight,
    body: '긍정 요인이 부정 요인보다 많지만 명확한 추세는 아직. 관찰 종목 리스트에 올려두고 후속 확인.',
  },
  {
    label: '관망',
    range: '0.35 ~ 0.65',
    color: '#9CA3AF',
    icon: Eye,
    body: '뚜렷한 신호 없음. 시장 전체 흐름이나 다른 종목 우선. 진입 근거 부족.',
  },
  {
    label: '주의',
    range: '0.20 ~ 0.35',
    color: '#E9B247',
    icon: AlertTriangle,
    body: '부정 요인이 더 많음. 보유 중이라면 익절·손절 시나리오 점검. 신규 진입은 비추천.',
  },
  {
    label: '위험',
    range: '< 0.20',
    color: '#DC4848',
    icon: ArrowDownRight,
    body: '명확한 하락/리스크 신호 집중. 분산 점검과 변동성 대비 필요. 추격매수 절대 금지.',
  },
];

const VOTERS = [
  { name: '그레이엄 (Graham)', emoji: '📊', style: '가치 투자의 아버지', color: '#48A698',
    body: 'PER·PBR·부채비율 등 재무 안정성 + 저평가 여부. 본질 가치 대비 싸야 산다는 원칙.' },
  { name: '다우 (Dow)', emoji: '📈', style: '추세 추종', color: '#F26D6D',
    body: '다우 이론의 시초. 고점·저점이 모두 우상향 = 추세 시작. MA·channel 같은 기술적 분석 강조.' },
  { name: '터링 (Turing)', emoji: '🤖', style: '단기 알고리즘', color: '#A855F7',
    body: '단기 패턴·모멘텀·breakout 신호. 5분~1일 시간 단위의 정량 시그널 집중.' },
  { name: '시러 (Shiller)', emoji: '🏛️', style: '거시·심리', color: '#5BA8F2',
    body: 'CAPE 지수·금리·소비자 심리. "시장 전체가 비싸면 개별 종목도 위험"이라는 거시 관점.' },
  { name: '케인즈 (Keynes)', emoji: '🌐', style: '거시 경제', color: '#F59E0B',
    body: '재정·통화 정책, 환율, 글로벌 이벤트가 한국 주식에 어떻게 흘러올지 모델링.' },
  { name: '탈레브 (Taleb)', emoji: '⚡', style: '꼬리위험', color: '#DC4848',
    body: '블랙스완·정상범위를 벗어난 사건에 대비. "안전해 보일 때가 가장 위험"이라는 역설.' },
];
