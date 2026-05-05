'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { RELATION_TYPES, RELATION_LABELS, type RelationType } from '@/app/(admin)/mapping/constants';
import { createMapping } from '@/app/(admin)/mapping/actions';

const schema = z.object({
  us_symbol: z.string().min(1).max(10),
  kr_ticker: z.string().min(1).max(10),
  relation_type: z.enum(RELATION_TYPES),
  impact_strength: z.number().min(0).max(1),
  rationale: z.string().optional(),
});
type Values = z.infer<typeof schema>;

export function AddMappingDialog({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      us_symbol: '',
      kr_ticker: '',
      relation_type: 'supply_chain',
      impact_strength: 0.5,
      rationale: '',
    },
  });
  const impact = form.watch('impact_strength');
  const relType = form.watch('relation_type');

  function onSubmit(values: Values) {
    startTransition(async () => {
      const res = await createMapping({
        ...values,
        us_symbol: values.us_symbol.toUpperCase(),
      });
      if (res.error) {
        toast.error(`생성 실패: ${res.error}`);
        return;
      }
      toast.success('매핑 추가됨');
      setOpen(false);
      form.reset();
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>새 매핑 추가</DialogTitle>
          <DialogDescription>US 종목·지수와 KR 관심 종목을 연결합니다.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="us_symbol">US 심볼</Label>
              <Input id="us_symbol" placeholder="NVDA" {...form.register('us_symbol')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kr_ticker">KR 티커</Label>
              <Input id="kr_ticker" placeholder="005930" {...form.register('kr_ticker')} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>관계 유형</Label>
            <Select
              value={relType}
              onValueChange={(v) => form.setValue('relation_type', v as RelationType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RELATION_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{RELATION_LABELS[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between">
              <Label>Impact 강도</Label>
              <span className="font-mono text-xs">{impact.toFixed(2)}</span>
            </div>
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={[impact]}
              onValueChange={(v) => form.setValue('impact_strength', v[0])}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rationale">근거 (선택)</Label>
            <textarea
              id="rationale"
              placeholder="예: NVDA HBM 수요 → SK하이닉스 매출 직결"
              className="w-full rounded-md border border-border bg-bg-secondary p-2 text-sm min-h-[60px]"
              {...form.register('rationale')}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              취소
            </Button>
            <Button
              type="submit"
              className="bg-gradient-brand text-white"
              disabled={pending}
            >
              {pending ? '저장 중...' : '추가'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
