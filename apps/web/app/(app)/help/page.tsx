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
            english="Open / Close — 개장가 / 종가"
            body="시가는 그날 거래가 시작될 때의 가격, 종가는 마감 때 가격. 한국 시장 기준 09:00 시작 → 15:30 종료."
            usage="종가가 시가보다 높으면 '오른 날'(빨강), 낮으면 '내린 날'(파랑). 한국 시장은 빨강이 상승, 파랑이 하락이에요. 미국은 반대 (초록 상승, 빨강 하락)."
          />
          <TermCard
            icon={Target}
            iconColor="#48A698"
            title="고가 / 저가"
            short="H / L"
            english="High / Low — 최고가 / 최저가"
            body="그날 도달한 가장 높은 가격과 가장 낮은 가격. 캔들봉의 위·아래 가느다란 선(꼬리)이 이것을 표시해요."
            usage="고가-저가 차이가 크면 그날 변동성이 큰 날. 작으면 박스권에서 움직인 잔잔한 날."
          />
          <TermCard
            icon={BarChart3}
            iconColor="#5BA8F2"
            title="거래량"
            short="V — Volume"
            english="Volume — 거래된 주식 수량"
            body="그날 거래된 주식의 수. 100만 = 100만 주가 손바뀜 했다는 뜻."
            usage="가격이 올랐을 때 거래량도 큼 = '진짜 추세'. 가격은 올랐는데 거래량 작음 = '의심해야 할 상승'. 거래량은 가격의 '신뢰도'예요."
          />
          <TermCard
            icon={TrendingUp}
            iconColor="#A855F7"
            title="등락률"
            short="±%"
            english="Change Rate — 변동률"
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
            english="Moving Average — 일정 기간 평균 가격을 연결한 선"
            body="최근 N일 종가의 평균을 잇는 선. MA20 = 20일 평균 가격선. 가격이 들쭉날쭉해도 '추세'를 부드럽게 보여줘요."
            usage="MA20 위에 있으면 단기 상승세, 아래면 단기 하락세. MA20이 MA60을 위로 뚫으면(골든크로스 = Golden Cross) 추세 전환 신호로 봐요. 반대는 데드크로스(Death Cross)."
          />
          <TermCard
            icon={Scale}
            iconColor="#A855F7"
            title="Bollinger Bands"
            short="BB ±2σ"
            english="Bollinger Bands — 변동성 범위 띠 (1980년대 John Bollinger 개발)"
            body="MA20에서 위·아래로 표준편차(σ, 시그마) 2배만큼 띠를 그어요. 가격이 통계적으로 약 95% 확률로 이 안에서 움직여요."
            usage="위쪽 띠 닿으면 '과열', 아래쪽 띠 닿으면 '과매도'. 띠가 좁아지면(squeeze = 스퀴즈) '곧 큰 변동이 온다'는 신호 — 변동성 축소 후 폭발(breakout = 가격 돌파) 자주 발생."
          />
          <TermCard
            icon={Gauge}
            iconColor="#A855F7"
            title="RSI (상대강도지수)"
            short="RSI(14)"
            english="Relative Strength Index — 1978년 J. Welles Wilder 개발"
            body="0~100 사이 숫자. 최근 14일 동안 오른 폭과 내린 폭의 비율을 계산해요. 모멘텀(momentum = 추진력) 측정 지표."
            usage="70 이상 = 과매수(곧 조정 가능성), 30 이하 = 과매도(반등 가능성). 50 근처면 중립. 가격은 신고가인데 RSI는 못 따라오면 '하락 다이버전스(bearish divergence)' = 위험 신호."
          />
          <TermCard
            icon={TrendingDown}
            iconColor="#A855F7"
            title="OBV (누적 매수/매도)"
            short="OBV"
            english="On-Balance Volume — 1963년 Joe Granville 개발"
            body="오른 날 거래량은 +, 내린 날 거래량은 −로 더해가는 그래프. 매집(accumulation, 큰손이 사들이는 중)과 분배(distribution, 큰손이 던지는 중)를 가시화."
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
            english="MAE = Mean Absolute Error / MAPE = Mean Absolute Percentage Error"
            body="MAE = 실측 ↔ 예측 차이의 절댓값(absolute value) 평균. MAPE = 그걸 비율(%, percentage)로 표시. 0에 가까울수록 정확. '평균 얼마나 빗나갔나'를 한 숫자로."
            usage="MAE 0.05 = 평균 5점(0~100 스케일) 빗나감 = 우수. MAPE 10% 이하면 ✓ 좋음, 30% 넘으면 ✗ 의심."
          />
          <TermCard
            icon={Gauge}
            iconColor="#A855F7"
            title="방향 일치율"
            short="Direction Accuracy"
            english="Directional Accuracy — 등락 방향(↑/↓) 적중률"
            body="Day-over-Day(DoD = 전일 대비) 변동의 부호가 일치한 비율. 50%는 coin flip(동전 던지기 = 무작위) 수준. 가격은 비슷한데 방향은 자주 틀린 평균 회귀 모델을 가려내는 지표."
            usage="60% 이상이면 의미 있는 모델. 50% 미만이면 그냥 어제값 쓰는 게 나음."
          />
          <TermCard
            icon={Sparkles}
            iconColor="#F59E0B"
            title="Skill Score"
            short="skill +N%"
            english="Skill Score — 기상학에서 유래한 모델 우수성 지표"
            body="Naive baseline(= 가장 단순한 예측: '내일 = 오늘') 대비 얼마나 우수한가. 공식: 1 − (모델MAE / naiveMAE). 양수면 모델 가치, 음수면 무용."
            usage="+30% 이상이면 충분히 가치 있는 모델. 0% 근처 = 단순 예측 수준, 음수면 모델이 오히려 해가 됨."
          />
          <TermCard
            icon={CheckCircle2}
            iconColor="#48A698"
            title="신뢰도"
            short="Reliability 0~100"
            english="Reliability Score — 샘플량·정확도·방향성 합성"
            body="샘플량(30%) + MAPE(35%) + 방향일치(35%) 가중합. 한 종목의 예측을 '얼마나 신뢰할 수 있나' 하나의 점수로 압축."
            usage="70+ 높음 — 참고할만, 50~69 보통 — 다른 근거 같이 보기, < 50 낮음 — 데이터 부족하니 추가 누적 후 재평가."
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

      {/* ─── 10. 추가 용어 사전 ─────────────────────────── */}
      <Section id="glossary" icon={Sigma} title="10. 추가 용어 사전 (Glossary)" subtitle="앞 섹션에 못 다룬 줄임말과 용어 모음 — 영문 원형 + 한글 의미 + 사용 맥락">
        <div className="space-y-6">
          {GLOSSARY.map((group) => (
            <div key={group.title}>
              <h3 className="text-lg font-bold text-txt-primary mb-3 pb-2 border-b-2 border-brand-purple/30 inline-block">
                {group.title}
              </h3>
              <dl className="grid md:grid-cols-2 gap-3">
                {group.terms.map((t) => (
                  <div
                    key={t.abbr}
                    className="rounded-lg border border-border-subtle/60 bg-bg-secondary p-3.5 hover:border-brand-purple/30 transition-colors"
                  >
                    <dt className="flex items-baseline gap-2 flex-wrap mb-1">
                      <span className="text-[15px] font-bold text-txt-primary font-mono">
                        {t.abbr}
                      </span>
                      {t.korean && (
                        <span className="text-[13px] text-txt-secondary font-semibold">
                          {t.korean}
                        </span>
                      )}
                    </dt>
                    {t.english && (
                      <p className="text-[12px] text-brand-purple italic font-medium mb-1">
                        {t.english}
                      </p>
                    )}
                    <dd className="text-[14px] text-txt-secondary leading-relaxed">
                      {t.desc}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
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
  icon: Icon, iconColor, title, short, english, body, usage,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  iconColor: string;
  title: string;
  short: string;
  /** Full English name expanded — e.g. 'MA' → 'Moving Average'.
   *  Surfaces directly under the title so users don't have to look
   *  up the abbreviation elsewhere. */
  english?: string;
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
          {english && (
            <p className="text-[12px] text-brand-purple mt-1 font-medium italic">
              {english}
            </p>
          )}
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
  { href: '#glossary',  label: '용어 사전',     icon: Sigma },
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

// ── Glossary entries: abbreviations, Korean name, English original,
// short description. Grouped by category so users can scan to the
// area they need. Includes EVERY abbreviation surfaced in the UI
// (and a few adjacent ones) so beginners don't need to leave the page.
const GLOSSARY: {
  title: string;
  terms: Array<{
    abbr: string;
    korean?: string;
    english?: string;
    desc: string;
  }>;
}[] = [
  {
    title: '📈 가격 · 캔들봉',
    terms: [
      { abbr: 'OHLC', korean: '시·고·저·종 4가격', english: 'Open / High / Low / Close',
        desc: '하나의 봉(period)을 구성하는 4가지 가격. 캔들 차트의 가장 기본.' },
      { abbr: 'OHLV', korean: '시·고·저·거래량', english: 'Open / High / Low / Volume',
        desc: 'OHLC + 거래량의 약어. 차트 헤더에 O/H/L/V로 표시되는 4종.' },
      { abbr: '양봉 / 음봉', korean: '상승봉 / 하락봉', english: 'Bullish candle / Bearish candle',
        desc: '양봉 = 종가 ≥ 시가, 한국에선 빨강. 음봉 = 종가 < 시가, 한국에선 파랑. 미국은 반대.' },
      { abbr: 'Wick', korean: '꼬리', english: 'Wick / Shadow',
        desc: '캔들 몸통 위·아래로 뻗은 가는 선. 위 꼬리는 그날 고가까지의 도전, 아래 꼬리는 저점 매수 흔적.' },
      { abbr: 'Body', korean: '몸통', english: 'Real Body',
        desc: '시가와 종가 사이의 직사각형. 두꺼울수록 그날 강한 한 방향 흐름.' },
      { abbr: 'Spread', korean: '스프레드', english: 'Spread — 매수·매도 호가 차이',
        desc: '동시 호가창의 매수1호가와 매도1호가 차이. 좁을수록 유동성 풍부.' },
      { abbr: 'Tick', korean: '호가단위', english: 'Tick size',
        desc: '한 번에 움직일 수 있는 최소 가격 단위. 한국에선 가격대별로 다름 (예: 1만원~10만원 구간 100원).' },
    ],
  },
  {
    title: '📊 기술적 지표 (Technical Indicators)',
    terms: [
      { abbr: 'MA', korean: '이동평균선', english: 'Moving Average',
        desc: '최근 N일 종가 평균을 잇는 선. 추세 부드럽게 보여줌. MA5/20/60/120일이 흔함.' },
      { abbr: 'EMA', korean: '지수 이동평균', english: 'Exponential Moving Average',
        desc: '최근 데이터에 더 큰 가중치를 둔 MA. 변화에 빠르게 반응. (이 서비스는 단순 MA 사용)' },
      { abbr: 'BB', korean: '볼린저 밴드', english: 'Bollinger Bands',
        desc: 'MA20 ± 표준편차 2배 띠. 가격이 위 띠 = 과열, 아래 띠 = 과매도.' },
      { abbr: 'RSI', korean: '상대강도지수', english: 'Relative Strength Index',
        desc: '0~100 모멘텀 지표. 70 ↑ 과매수, 30 ↓ 과매도.' },
      { abbr: 'OBV', korean: '온밸런스 볼륨', english: 'On-Balance Volume',
        desc: '상승일 거래량 +, 하락일 −로 누적. 매집 vs 분배 가시화.' },
      { abbr: 'MACD', korean: '맥디', english: 'Moving Average Convergence Divergence',
        desc: 'EMA12 − EMA26 + 신호선. 모멘텀 전환점 잡는 데 사용. (현재 UI엔 미표시)' },
      { abbr: 'VWAP', korean: '거래량 가중 평균가', english: 'Volume-Weighted Average Price',
        desc: '거래량 가중치를 둔 평균가. 대형 펀드의 진입 기준선으로 자주 사용.' },
      { abbr: 'ATR', korean: '평균 진폭', english: 'Average True Range',
        desc: '평균 일중 변동폭. 손절·익절 폭 산정에 활용. (현재 UI엔 미표시)' },
      { abbr: 'σ', korean: '시그마 / 표준편차', english: 'Sigma / Standard Deviation',
        desc: '데이터가 평균에서 얼마나 흩어져 있는지. ±1σ 안에 약 68%, ±2σ 안에 약 95% 데이터 포함.' },
      { abbr: 'Breakout', korean: '돌파', english: 'Breakout',
        desc: '가격이 저항선 또는 박스권 위쪽 경계를 뚫고 올라가는 현상. 거래량 동반 시 신뢰도 ↑.' },
      { abbr: 'Breakdown', korean: '이탈', english: 'Breakdown',
        desc: '가격이 지지선 또는 박스권 아래쪽 경계를 뚫고 내려가는 현상. 매도 압력 신호.' },
      { abbr: 'Golden Cross', korean: '골든크로스', english: 'Golden Cross',
        desc: 'MA20이 MA60(혹은 단기MA가 장기MA를) 위로 뚫는 현상. 추세 전환 상승 신호로 해석.' },
      { abbr: 'Death Cross', korean: '데드크로스', english: 'Death Cross',
        desc: '단기MA가 장기MA를 아래로 뚫는 현상. 추세 전환 하락 신호.' },
      { abbr: 'Divergence', korean: '다이버전스', english: 'Divergence',
        desc: '가격은 신고가/신저가인데 지표(예: RSI)는 못 따라오는 현상. 추세 전환 가능성.' },
      { abbr: 'Support / Resistance', korean: '지지 / 저항', english: 'Support / Resistance',
        desc: '지지선 = 가격이 자주 반등하는 아래쪽 가격대. 저항선 = 자주 막히는 위쪽 가격대.' },
    ],
  },
  {
    title: '💰 재무 지표 (Financial Ratios)',
    terms: [
      { abbr: 'PER (P/E)', korean: '주가수익비율', english: 'Price-to-Earnings Ratio',
        desc: '주가 ÷ 주당순이익(EPS). 낮을수록 저평가. 코스피 평균 10~15배 정도.' },
      { abbr: 'PBR (P/B)', korean: '주가순자산비율', english: 'Price-to-Book Ratio',
        desc: '주가 ÷ 주당순자산(BPS). 1 미만이면 청산가치 이하 = 저평가 가능성.' },
      { abbr: 'EPS', korean: '주당순이익', english: 'Earnings Per Share',
        desc: '순이익 ÷ 발행주식수. 한 주당 회사가 1년에 번 돈.' },
      { abbr: 'BPS', korean: '주당순자산', english: 'Book-value Per Share',
        desc: '순자산 ÷ 발행주식수. 한 주당 회사의 청산 가치.' },
      { abbr: 'ROE', korean: '자기자본이익률', english: 'Return on Equity',
        desc: '순이익 ÷ 자기자본. 회사가 주주 돈으로 얼마나 벌었나. 15%+ 우량 기준.' },
      { abbr: 'ROA', korean: '총자산이익률', english: 'Return on Assets',
        desc: '순이익 ÷ 총자산. 자산 활용 효율성.' },
      { abbr: 'DPS', korean: '주당배당금', english: 'Dividend Per Share',
        desc: '한 주당 받는 연간 배당금.' },
      { abbr: 'Dividend Yield', korean: '배당수익률', english: 'Dividend Yield',
        desc: '연간 DPS ÷ 현재 주가 × 100. "이 가격에 사면 배당으로 몇 % 받나"' },
      { abbr: 'CAPE', korean: '경기조정 PER', english: 'Cyclically Adjusted P/E (Shiller PE)',
        desc: 'Shiller가 만든 10년 평균 실질 EPS 기반 PER. 시장 전체 거품 판단에 활용.' },
      { abbr: 'Market Cap', korean: '시가총액', english: 'Market Capitalization',
        desc: '주가 × 발행주식수. 회사 전체 가치. 코스피 1위 삼성전자 약 500조원.' },
    ],
  },
  {
    title: '🤖 AI · 통계 · ML',
    terms: [
      { abbr: 'AI', korean: '인공지능', english: 'Artificial Intelligence',
        desc: '데이터에서 패턴을 학습하는 컴퓨터 시스템 통칭.' },
      { abbr: 'ML', korean: '기계 학습', english: 'Machine Learning',
        desc: '명시적 코드 대신 데이터로부터 규칙을 자동 학습. AI의 한 분야.' },
      { abbr: 'LLM', korean: '대규모 언어 모델', english: 'Large Language Model',
        desc: 'GPT·Claude 같은 자연어 처리 모델. 이 서비스의 AI 종합 코멘트 생성에 사용.' },
      { abbr: 'GBM / GBR', korean: '그래디언트 부스팅', english: 'Gradient Boosting Machine / Regressor',
        desc: '여러 개의 약한 결정 트리를 순차적으로 결합해 예측. 점수 예측 모델로 사용.' },
      { abbr: 'OLS', korean: '최소제곱법', english: 'Ordinary Least Squares',
        desc: '직선 회귀의 가장 기본. 데이터에서 가장 잘 맞는 직선 찾기. 점수 예측 fallback 모델.' },
      { abbr: 'MAE', korean: '평균 절대 오차', english: 'Mean Absolute Error',
        desc: '|실측 − 예측|의 평균. 단위는 원본 데이터와 동일.' },
      { abbr: 'MAPE', korean: '평균 절대 비율 오차', english: 'Mean Absolute Percentage Error',
        desc: 'MAE를 비율(%)로. 데이터 크기와 무관하게 비교 가능.' },
      { abbr: 'RMSE', korean: '평균 제곱근 오차', english: 'Root Mean Square Error',
        desc: '큰 오차에 더 큰 페널티를 주는 정확도 지표.' },
      { abbr: 'AUC', korean: 'ROC 곡선 아래 면적', english: 'Area Under the (ROC) Curve',
        desc: '분류 모델 성능 지표. 0.5 = 무작위, 1.0 = 완벽.' },
      { abbr: 'CI', korean: '신뢰구간', english: 'Confidence Interval',
        desc: '예측의 불확실성 범위. 95% CI = 95% 확률로 이 안에 실제값 위치.' },
      { abbr: 'Backtest', korean: '백테스트', english: 'Back-test',
        desc: '과거 데이터로 전략을 시뮬레이션. 미래 검증의 한계는 있지만 최소 기준선.' },
      { abbr: 'Drawdown', korean: '낙폭', english: 'Drawdown',
        desc: '고점 대비 최대 하락폭. 백테스트에서 위험도 평가 핵심 지표.' },
      { abbr: 'Sharpe Ratio', korean: '샤프 비율', english: 'Sharpe Ratio',
        desc: '수익률 ÷ 변동성. 1 이상이면 우량 전략, 2 이상이면 우수.' },
      { abbr: 'Naive Baseline', korean: '순진 기준선', english: 'Naive Baseline',
        desc: '"내일 = 오늘"이라고 가정한 가장 단순한 예측. 모델이 이걸 못 이기면 무용.' },
    ],
  },
  {
    title: '🏛️ 시장 · 거래 용어',
    terms: [
      { abbr: 'KOSPI', korean: '코스피', english: 'Korea Composite Stock Price Index',
        desc: '한국거래소 유가증권시장 지수. 대형주 중심 (삼성전자·SK하이닉스 등).' },
      { abbr: 'KOSDAQ', korean: '코스닥', english: 'Korean Securities Dealers Automated Quotations',
        desc: '한국 중소·벤처 종목 시장. 셀트리온·에코프로 등.' },
      { abbr: 'KRX', korean: '한국거래소', english: 'Korea Exchange',
        desc: '코스피·코스닥을 운영하는 거래소.' },
      { abbr: 'NYSE', korean: '뉴욕증권거래소', english: 'New York Stock Exchange',
        desc: '세계 최대 거래소. 대형 우량주(블루칩) 위주.' },
      { abbr: 'NASDAQ', korean: '나스닥', english: 'National Association of Securities Dealers Automated Quotations',
        desc: '미국 기술주 중심 거래소. 애플·마이크로소프트·엔비디아 등.' },
      { abbr: 'ETF', korean: '상장지수펀드', english: 'Exchange-Traded Fund',
        desc: '주식처럼 거래되는 펀드. 한 번에 여러 종목에 분산 투자.' },
      { abbr: 'ETN', korean: '상장지수증권', english: 'Exchange-Traded Note',
        desc: 'ETF와 비슷하지만 증권사 신용 기반. 발행사 부도 위험 존재.' },
      { abbr: 'IPO', korean: '기업공개', english: 'Initial Public Offering',
        desc: '비상장 회사가 처음 주식을 거래소에 상장하는 과정.' },
      { abbr: 'Bull / Bear', korean: '강세장 / 약세장', english: 'Bull / Bear Market',
        desc: '강세장 = 지수 +20% 이상 상승 추세. 약세장 = 고점 대비 -20% 이상 하락.' },
      { abbr: 'Bid / Ask', korean: '매수호가 / 매도호가', english: 'Bid / Ask',
        desc: '사겠다고 부르는 가격 / 팔겠다고 부르는 가격. 동시호가창의 양쪽 호가.' },
      { abbr: '상한가 / 하한가', korean: '±30% 한계', english: 'Daily Price Limit',
        desc: '한국 시장에서 하루 ±30% 이상 변동 못 함. 거래정지 트리거.' },
      { abbr: '시가총액', korean: '시총', english: 'Market Cap',
        desc: '주가 × 총 발행 주식수. 회사 전체 가치 평가 지표.' },
      { abbr: '대형주 / 중형주 / 소형주', korean: 'Large/Mid/Small Cap',
        english: 'Large-cap / Mid-cap / Small-cap',
        desc: '시가총액 기준 분류. 한국 기준 대형주 = 시총 상위 100, 중형 = 101~300, 소형 = 그 외.' },
      { abbr: '대장주', korean: '섹터 대표', english: 'Leader Stock',
        desc: '한 섹터에서 거래량·시총·주가 모두 1위인 종목. 섹터 흐름을 가장 잘 반영.' },
      { abbr: '횡보', korean: '박스권 움직임', english: 'Sideways / Consolidation',
        desc: '가격이 일정 범위에서 오르내리며 추세 없음. 돌파를 기다리는 구간.' },
      { abbr: '추세', korean: '방향성', english: 'Trend',
        desc: '가격이 일관된 방향(상승·하락·횡보)으로 이어지는 흐름.' },
      { abbr: '모멘텀', korean: '추진력', english: 'Momentum',
        desc: '가격 변화의 강도. 강한 모멘텀 = 큰 폭의 연속 상승/하락.' },
      { abbr: '변동성', korean: '진폭', english: 'Volatility',
        desc: '가격 흔들림의 크기. σ로 측정. 변동성 높음 = 위험 + 기회 모두 큼.' },
      { abbr: '유동성', korean: '거래 활발도', english: 'Liquidity',
        desc: '얼마나 쉽게 사고팔 수 있는가. 거래량과 비례. 유동성 낮으면 슬리피지 위험.' },
      { abbr: '슬리피지', korean: '체결 미끄러짐', english: 'Slippage',
        desc: '주문가와 실제 체결가 차이. 큰 주문이나 유동성 낮을 때 발생.' },
    ],
  },
  {
    title: '🔔 이 서비스 고유 용어',
    terms: [
      { abbr: '5단계 신호', korean: '강한 관심·관심·관망·주의·위험', english: 'Five-Tier Signal',
        desc: 'AI 종합점수(0~1)를 5단계 등급으로 분류. 자세히는 섹션 5 참고.' },
      { abbr: 'Voter', korean: '6 전문가', english: 'AI Persona Voter',
        desc: '그레이엄·다우·터링·시러·케인즈·탈레브 6명의 투자 거장 관점을 코드로 재현. 다수결로 합의 도출.' },
      { abbr: 'Watchlist', korean: '관심주식', english: 'Watch List',
        desc: 'AI가 매일 분석·예측하는 50종목. LNB 좌측 사이드바에 표시.' },
      { abbr: 'Master 종목', korean: '마스터 등록', english: 'Master Universe',
        desc: '데이터는 수집되지만 매일 AI 분석은 안 되는 외부 종목. 관심주식 외 추가 항목.' },
      { abbr: 'RAG', korean: '검색 증강 생성', english: 'Retrieval-Augmented Generation',
        desc: 'LLM이 답할 때 외부 지식 베이스를 검색해서 활용하는 패턴. 이 서비스의 투자 시나리오 청크 검색에 사용.' },
      { abbr: '청크', korean: '지식 단위', english: 'Knowledge Chunk',
        desc: 'RAG에서 검색되는 한 단위. "Nvidia 상승이 한국 HBM 관련주에 미치는 영향" 같은 투자 판단 단위로 작성.' },
    ],
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
