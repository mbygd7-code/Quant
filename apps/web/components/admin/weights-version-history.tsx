'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Power } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { activateWeightConfig } from '@/app/(admin)/weights/actions';

interface WeightConfig {
  id: string;
  version: string;
  is_active: boolean;
  notes: string | null;
  created_at: string;
}

export function VersionHistory({
  configs,
  activeId,
}: {
  configs: WeightConfig[];
  activeId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function activate(id: string, version: string) {
    startTransition(async () => {
      const res = await activateWeightConfig(id);
      if (res.error) toast.error(`활성화 실패: ${res.error}`);
      else {
        toast.success(`v${version} 활성화됨`);
        router.refresh();
      }
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-heading">버전 히스토리</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 max-h-[600px] overflow-y-auto">
          {configs.map((c) => (
            <div
              key={c.id}
              className={`rounded-md border p-3 transition-colors ${
                c.id === activeId
                  ? 'border-brand-purple/40 bg-brand-purple/5'
                  : 'border-border bg-bg-secondary/60'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-baseline gap-2 min-w-0">
                  {c.is_active ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-brand-purple shrink-0" />
                  ) : (
                    <span className="h-3.5 w-3.5 rounded-full border border-border shrink-0" />
                  )}
                  <span className="font-mono text-sm">v{c.version}</span>
                  {c.is_active && (
                    <span className="text-[10px] text-brand-purple uppercase tracking-wider">
                      active
                    </span>
                  )}
                </div>
                {!c.is_active && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => activate(c.id, c.version)}
                    disabled={pending}
                  >
                    <Power className="h-3 w-3 mr-1" />
                    활성화
                  </Button>
                )}
              </div>
              {c.notes && (
                <p className="mt-1.5 text-xs text-txt-secondary line-clamp-2">{c.notes}</p>
              )}
              <p className="mt-1 text-[10px] text-txt-muted">
                {new Date(c.created_at).toLocaleString('ko-KR')}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
