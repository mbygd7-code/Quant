import { ChunkEditor } from '@/components/admin/chunk-editor';

export default function NewChunkPage() {
  return (
    <ChunkEditor
      mode="create"
      initial={{
        id: '',
        topic: '',
        markets: ['KR'],
        sectors: [],
        related_tickers: [],
        trigger_conditions: [],
        positive_signal: '관심',
        risk_warning: '',
        body: '# 새 청크\n\n## 트리거 조건\n- ',
      }}
    />
  );
}
