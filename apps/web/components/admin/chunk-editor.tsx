'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  createChunk,
  updateChunk,
  deleteChunk,
  regenerateEmbedding,
} from '@/app/(admin)/knowledge/actions';

// react-md-editor uses window — load only on client
const MdEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });

interface FormState {
  id: string;
  topic: string;
  markets: string[];
  sectors: string[];
  related_tickers: string[];
  trigger_conditions: string[];
  positive_signal: string;
  risk_warning: string;
  body: string;
}

const SIGNAL_OPTIONS = ['강한 관심', '관심', '관망', '주의', '위험'] as const;
const MARKETS = ['US', 'KR', 'JP', 'CN', 'EU'] as const;

export function ChunkEditor({
  mode,
  initial,
}: {
  mode: 'create' | 'edit';
  initial: FormState;
}) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(initial);
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tickerInput, setTickerInput] = useState('');
  const [sectorInput, setSectorInput] = useState('');
  const [conditionInput, setConditionInput] = useState('');

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function addToList(key: 'sectors' | 'related_tickers' | 'trigger_conditions', value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    setForm((prev) => ({
      ...prev,
      [key]: prev[key].includes(trimmed) ? prev[key] : [...prev[key], trimmed],
    }));
  }

  function removeFromList(key: 'sectors' | 'related_tickers' | 'trigger_conditions', value: string) {
    setForm((prev) => ({ ...prev, [key]: prev[key].filter((v) => v !== value) }));
  }

  function toggleMarket(market: string) {
    setForm((prev) => ({
      ...prev,
      markets: prev.markets.includes(market)
        ? prev.markets.filter((m) => m !== market)
        : [...prev.markets, market],
    }));
  }

  function handleSave() {
    startTransition(async () => {
      if (mode === 'create') {
        const res = await createChunk({
          id: form.id,
          topic: form.topic,
          markets: form.markets,
          sectors: form.sectors,
          related_tickers: form.related_tickers,
          trigger_conditions: form.trigger_conditions,
          positive_signal: form.positive_signal || null,
          risk_warning: form.risk_warning || null,
          body: form.body,
        });
        if (res.error) toast.error(`저장 실패: ${res.error}`);
        else {
          toast.success('청크 생성됨 + 임베딩 생성됨');
          router.push(`/knowledge/${res.id}`);
        }
      } else {
        const res = await updateChunk(form.id, {
          topic: form.topic,
          markets: form.markets,
          sectors: form.sectors,
          related_tickers: form.related_tickers,
          trigger_conditions: form.trigger_conditions,
          positive_signal: form.positive_signal || null,
          risk_warning: form.risk_warning || null,
          body: form.body,
        });
        if (res.error) toast.error(`저장 실패: ${res.error}`);
        else toast.success('저장됨 (본문 변경 시 [임베딩 재생성] 권장)');
      }
    });
  }

  function handleRegenerate() {
    startTransition(async () => {
      const res = await regenerateEmbedding(form.id);
      if (res.error) toast.error(`임베딩 실패: ${res.error}`);
      else toast.success('임베딩 재생성 완료 ($0.00002)');
    });
  }

  function handleDelete() {
    startTransition(async () => {
      await deleteChunk(form.id);
    });
  }

  return (
    <div className="space-y-4 fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          {mode === 'create' ? '새 청크' : `청크 편집 — ${form.id || ''}`}
        </h1>
        <div className="flex gap-2">
          {mode === 'edit' && (
            <Button variant="outline" onClick={handleRegenerate} disabled={pending}>
              <RefreshCw className="h-4 w-4 mr-1" />
              임베딩 재생성
            </Button>
          )}
          <Button
            className="bg-gradient-brand text-white"
            onClick={handleSave}
            disabled={pending}
          >
            <Save className="h-4 w-4 mr-1" />
            {pending ? '저장 중...' : '저장'}
          </Button>
          {mode === 'edit' && (
            <Button variant="outline" onClick={() => setConfirmDelete(true)} disabled={pending}>
              <Trash2 className="h-4 w-4 mr-1 text-status-error" />
              삭제
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_3fr]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-heading">메타데이터</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {mode === 'create' && (
              <div className="space-y-1.5">
                <Label htmlFor="id">청크 ID *</Label>
                <Input
                  id="id"
                  placeholder="nvda_kr_hbm_001"
                  value={form.id}
                  onChange={(e) => updateField('id', e.target.value)}
                />
                <p className="text-[11px] text-txt-muted">소문자 + 숫자 + _ 만 사용 가능</p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="topic">주제 *</Label>
              <Input
                id="topic"
                placeholder="Nvidia 상승이 한국 HBM 관련주에 미치는 영향"
                value={form.topic}
                onChange={(e) => updateField('topic', e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label>대상 시장</Label>
              <div className="flex flex-wrap gap-1.5">
                {MARKETS.map((m) => {
                  const on = form.markets.includes(m);
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => toggleMarket(m)}
                      className={`px-2.5 py-1 rounded-sm text-xs border transition-colors ${
                        on
                          ? 'bg-brand-purple/15 text-txt-primary border-brand-purple/30'
                          : 'border-border text-txt-secondary hover:bg-bg-tertiary'
                      }`}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            </div>

            <TagInput
              label="섹터"
              placeholder="반도체, 2차전지..."
              value={form.sectors}
              inputValue={sectorInput}
              setInputValue={setSectorInput}
              onAdd={(v) => addToList('sectors', v)}
              onRemove={(v) => removeFromList('sectors', v)}
            />

            <TagInput
              label="관련 티커"
              placeholder="NVDA, 005930..."
              value={form.related_tickers}
              inputValue={tickerInput}
              setInputValue={setTickerInput}
              onAdd={(v) => addToList('related_tickers', v.toUpperCase())}
              onRemove={(v) => removeFromList('related_tickers', v)}
              mono
            />

            <TagInput
              label="트리거 조건"
              placeholder="예: Nvidia 종가 +2% 이상"
              value={form.trigger_conditions}
              inputValue={conditionInput}
              setInputValue={setConditionInput}
              onAdd={(v) => addToList('trigger_conditions', v)}
              onRemove={(v) => removeFromList('trigger_conditions', v)}
              wide
            />

            <div className="space-y-1.5">
              <Label>긍정 시그널</Label>
              <Select
                value={form.positive_signal || 'none'}
                onValueChange={(v) => updateField('positive_signal', v === 'none' ? '' : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="선택" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— 없음 —</SelectItem>
                  {SIGNAL_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="risk_warning">리스크 경고</Label>
              <textarea
                id="risk_warning"
                className="w-full rounded-md border border-border bg-bg-secondary p-2 text-sm min-h-[60px]"
                placeholder="장 초반 갭상승 시 추격매수 위험"
                value={form.risk_warning}
                onChange={(e) => updateField('risk_warning', e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-heading">본문 (Markdown)</CardTitle>
          </CardHeader>
          <CardContent>
            <div data-color-mode="dark">
              <MdEditor
                value={form.body}
                onChange={(v) => updateField('body', v ?? '')}
                height={520}
                preview="live"
              />
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>청크 삭제</DialogTitle>
            <DialogDescription>
              <strong>{form.id}</strong> 청크를 삭제합니다. 임베딩 포함 모든 데이터가 영구 삭제됩니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>취소</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={pending}>
              삭제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TagInput({
  label,
  placeholder,
  value,
  inputValue,
  setInputValue,
  onAdd,
  onRemove,
  mono = false,
  wide = false,
}: {
  label: string;
  placeholder: string;
  value: string[];
  inputValue: string;
  setInputValue: (v: string) => void;
  onAdd: (v: string) => void;
  onRemove: (v: string) => void;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {value.map((v) => (
          <Badge
            key={v}
            variant="outline"
            className={`gap-1 pr-1 ${mono ? 'font-mono' : ''}`}
          >
            {v}
            <button
              type="button"
              onClick={() => onRemove(v)}
              className="hover:text-status-error"
              aria-label={`${v} 제거`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Input
          placeholder={placeholder}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onAdd(inputValue);
              setInputValue('');
            }
          }}
          className={wide ? '' : 'max-w-sm'}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => {
            onAdd(inputValue);
            setInputValue('');
          }}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
