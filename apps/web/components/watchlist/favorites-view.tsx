'use client';

import { useEffect, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BackButton } from '@/components/layout/back-button';
import { WatchlistTable } from '@/components/watchlist/watchlist-table';
import { FavoritePicker, type UniverseItem } from '@/components/watchlist/favorite-picker';
import { useFavorites } from '@/lib/use-favorites';
import type { Role, Signal } from '@/lib/types';
import type { WatchlistRow } from '@/lib/queries/watchlist';

/**
 * Client-side renderer for the /favorites page.
 *
 * The favorites set lives in browser localStorage, so we hydrate on mount,
 * fan out two parallel API calls:
 *   1. /api/watchlist-list — gives us full enriched rows (signal, score,
 *      live quote) for any ticker that's part of the admin universe.
 *   2. /api/stocks/resolve  — picks up metadata (name, market, sector)
 *      for tickers outside the universe (user-promoted externals).
 *
 * The resulting rows feed straight into <WatchlistTable> so the visual
 * format matches /watchlist (주식리스트) — same columns, filters, ★ toggle.
 */
export function FavoritesView({ role }: { role: Role }) {
  const { tickers, hydrated, add } = useFavorites();
  const [rows, setRows] = useState<WatchlistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [universe, setUniverse] = useState<UniverseItem[] | null>(null);
  const [universeRevision, setUniverseRevision] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Universe (admin master watchlist) — feeds the FavoritePicker dialog.
  // Separate from the personal-favorites fetch below because the picker
  // shows ALL universe stocks regardless of whether they're in favorites.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/watchlist-list', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { items?: UniverseItem[] }) => {
        if (!cancelled) setUniverse(j.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setUniverse([]);
      });
    return () => {
      cancelled = true;
    };
  }, [universeRevision]);

  useEffect(() => {
    if (!hydrated) return;
    if (tickers.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    Promise.all([
      fetch('/api/watchlist-list', { cache: 'no-store' }).then((r) =>
        r.ok ? r.json() : { items: [] },
      ),
      fetch(`/api/stocks/resolve?tickers=${encodeURIComponent(tickers.join(','))}`, {
        cache: 'no-store',
      }).then((r) => (r.ok ? r.json() : { items: [] })),
    ])
      .then(([wl, rs]: [
        { items?: Array<WatchlistRow & { signal: string | null }> },
        { items?: Array<{ ticker: string; name: string; market: string; sector: string | null }> },
      ]) => {
        if (cancelled) return;

        const universeByTicker = new Map<string, WatchlistRow & { signal: string | null }>();
        for (const it of wl.items ?? []) universeByTicker.set(it.ticker, it);

        const resolveByTicker = new Map<
          string,
          { name: string; market: string; sector: string | null }
        >();
        for (const it of rs.items ?? []) resolveByTicker.set(it.ticker, it);

        // Preserve favorites order (insertion order).
        const projected: WatchlistRow[] = tickers.map((t) => {
          const u = universeByTicker.get(t);
          if (u) {
            return {
              ticker: u.ticker,
              name: u.name || resolveByTicker.get(t)?.name || t,
              market: u.market || resolveByTicker.get(t)?.market || '',
              sector: u.sector ?? resolveByTicker.get(t)?.sector ?? null,
              signal: (u.signal as Signal) ?? null,
              final_score: u.final_score ?? null,
              change_rate: u.change_rate ?? null,
              close: u.close ?? null,
            };
          }
          const meta = resolveByTicker.get(t);
          return {
            ticker: t,
            name: meta?.name ?? t,
            market: meta?.market ?? '',
            sector: meta?.sector ?? null,
            signal: null,
            final_score: null,
            change_rate: null,
            close: null,
          };
        });

        setRows(projected);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        // Even on a network blip we render the bare tickers so the user
        // can still see / un-favorite them.
        setRows(
          tickers.map((t) => ({
            ticker: t,
            name: t,
            market: '',
            sector: null,
            signal: null,
            final_score: null,
            change_rate: null,
            close: null,
          })),
        );
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // Keyed by the joined ticker string so the effect only re-runs when
    // the actual set of favorites changes (not every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, tickers.join(',')]);

  return (
    <div className="space-y-5 fade-in">
      <BackButton fallbackHref="/stocks/kr" label="뒤로" />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">관심주식</h1>
          <div className="mt-1 text-sm text-txt-secondary">
            {rows.length} 종목 · 개인 즐겨찾기{' '}
            <Badge variant="outline" className="ml-1 align-middle">{role}</Badge>
          </div>
        </div>
        <Button
          onClick={() => setPickerOpen(true)}
          className="bg-gradient-brand text-white hover:opacity-90"
        >
          <Plus className="h-4 w-4 mr-1" />
          종목 추가
        </Button>
      </div>

      <FavoritePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        universe={universe}
        existing={tickers}
        onAdd={(t) => add(t)}
        onUniverseChanged={() => setUniverseRevision((n) => n + 1)}
      />

      {!hydrated || loading ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-10 text-sm text-txt-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            관심주식 불러오는 중…
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-txt-secondary text-center">
            아직 관심주식이 비어 있습니다.
            <br />
            좌측 사이드바 <strong className="text-txt-primary">관심주식</strong> 헤더의{' '}
            <strong className="text-txt-primary">＋</strong> 버튼이나, 종목 상세 페이지의{' '}
            <strong className="text-txt-primary">관심주식에 추가</strong> 버튼으로 등록하세요.
          </CardContent>
        </Card>
      ) : (
        // `date` is empty — the 자세히 column needs a date to deep-link to
        // /reports. We can revisit by querying the latest report date if
        // users want that link from here too.
        <WatchlistTable rows={rows} date="" role={role} />
      )}
    </div>
  );
}

