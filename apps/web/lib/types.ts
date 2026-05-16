// Database row types — manually typed against supabase/migrations.
// (Supabase CLI gen types is preferred long-term; for now, hand-rolled
// keeps the dev loop simple and matches the schema we control.)

export type Role = 'admin' | 'beta' | 'user';

export type Signal = '강한 관심' | '관심' | '관망' | '주의' | '위험';

export interface Stock {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  industry: string | null;
  is_watchlist: boolean;
}

export interface AiScore {
  date: string;
  ticker: string;
  global_market_score: number | null;
  sector_score: number | null;
  related_us_stock_score: number | null;
  news_sentiment_score: number | null;
  fundamental_score: number | null;
  volume_flow_score: number | null;
  risk_penalty: number | null;
  kr_fear_greed_score: number | null;
  final_score: number;
  signal: Signal;
  rationale_json: {
    reasons?: string[];
    risks?: string[];
    summary?: string;
    related_news?: { title: string; url: string; source?: string }[];
  } | null;
}

export interface KoreaQuote {
  date: string;
  ticker: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  change_rate: number | null;
}

export interface GlobalMarket {
  date: string;
  symbol: string;
  close: number | null;
  change_rate: number | null;
  asset_class: string | null;
}

export interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  role: Role;
  telegram_chat_id: string | null;
  telegram_link_code: string | null;
  link_code_expires_at: string | null;
  notification_enabled: boolean;
  notification_time: string;
}

export interface UserWatchlistRow {
  user_id: string;
  ticker: string;
  added_at: string;
  stocks: Pick<Stock, 'name' | 'sector' | 'market' | 'industry'> | null;
}

export interface RagChunk {
  id: string;
  topic: string;
  positive_signal: string | null;
  risk_warning: string | null;
  body: string;
  related_tickers: string[] | null;
  sectors: string[] | null;
}

export const SIGNAL_ORDER: Record<Signal, number> = {
  '강한 관심': 0,
  '관심': 1,
  '관망': 2,
  '주의': 3,
  '위험': 4,
};

export const ROLE_WATCHLIST_LIMIT: Record<Role, number> = {
  admin: 9999,
  beta: 30,
  user: 10,
};
