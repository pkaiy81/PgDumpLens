'use client';

import { useEffect, useRef } from 'react';
import mermaid from 'mermaid';

interface MermaidDiagramProps {
  chart: string;
  className?: string;
}

export function MermaidDiagram({ chart, className = '' }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: true,
      theme: 'default',
      er: {
        useMaxWidth: true,
        minEntityWidth: 100,
        minEntityHeight: 75,
        entityPadding: 15,
      },
    });

    if (containerRef.current) {
      containerRef.current.innerHTML = chart;
      mermaid.contentLoaded();
    }
  }, [chart]);

  return (
    <div
      ref={containerRef}
      className={`mermaid overflow-auto ${className}`}
    />
  );
}
