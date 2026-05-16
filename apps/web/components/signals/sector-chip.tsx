import { cn } from '@/lib/utils';
import { formatScore } from '@/lib/format';

interface Props {
  sector: string;
  avgScore: number;
  counts: Record<string, number>;
}

export function SectorChip({ sector, avgScore, counts }: Props) {
  const filled = Math.round(avgScore * 5);
  const dots = Array.from({ length: 5 }, (_, i) => i < filled);
  const tone =
    avgScore >= 0.65 ? 'text-txt-primary'
    : avgScore >= 0.50 ? 'text-txt-secondary'
    : avgScore >= 0.35 ? 'text-status-warning'
    : 'text-status-error';

  const breakdown = ['강한 관심', '관심', '관망', '주의', '위험']
    .map((sig) => `${sig} ${counts[sig] ?? 0}`)
    .join(' · ');

  return (
    <div
      className="rounded-md border border-border bg-bg-secondary/60 px-3 py-2 text-xs"
      title={breakdown}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-txt-primary">{sector}</span>
        <span className={cn('font-mono', tone)}>{formatScore(avgScore)}</span>
      </div>
      <div className="mt-1 flex gap-0.5">
        {dots.map((on, i) => (
          <span
            key={i}
            className={cn(
              'h-1.5 flex-1 rounded-sm',
              on ? 'bg-gradient-brand' : 'bg-border-divider',
            )}
          />
        ))}
      </div>
    </div>
  );
}
