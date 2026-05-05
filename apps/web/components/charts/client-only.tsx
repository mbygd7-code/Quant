'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Recharts ResponsiveContainer는 부모의 clientWidth가 0보다 작으면
 * "width(-1) and height(-1) of chart should be greater than 0" 경고를
 * 띄운다. SSR 직후 첫 페인트에서 ref 측정이 되지 않은 상태로 ResponsiveContainer
 * 가 마운트되면 거의 항상 발생.
 *
 * ResizeObserver로 부모가 실제 양의 크기를 얻을 때까지 자식 렌더를 보류한다.
 */
export function ClientOnly({
  children,
  fallback,
}: {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setReady(true);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver(measure);
    obs.observe(node);
    return () => obs.disconnect();
  }, []);

  return (
    <div ref={ref} className="h-full w-full">
      {ready ? children : fallback}
    </div>
  );
}
