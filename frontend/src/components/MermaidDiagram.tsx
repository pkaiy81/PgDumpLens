'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import mermaid from 'mermaid';

interface MermaidDiagramProps {
  chart: string;
  className?: string;
  onExportSvg?: (svg: string) => void;
}

export function MermaidDiagram({ chart, className = '', onExportSvg }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      maxTextSize: 1000000,
      er: {
        useMaxWidth: false,
        minEntityWidth: 120,
        minEntityHeight: 80,
        entityPadding: 20,
        fontSize: 14,
      },
      securityLevel: 'loose',
    });

    const renderDiagram = async () => {
      if (!chart || !containerRef.current) return;
      
      try {
        const id = `mermaid-${Date.now()}`;
        const { svg } = await mermaid.render(id, chart);
        setSvg(svg);
        setError(null);
        // Reset view when diagram changes
        setScale(1);
        setPosition({ x: 0, y: 0 });
      } catch (err) {
        console.error('Mermaid render error:', err);
        setError(err instanceof Error ? err.message : 'Failed to render diagram');
      }
    };

    renderDiagram();
  }, [chart]);

  // Export SVG
  const handleExportSvg = useCallback(() => {
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'er-diagram.svg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [svg]);

  // Export PNG
  const handleExportPng = useCallback(async () => {
    if (!svg) return;
    const svgEl = svgContainerRef.current?.querySelector('svg');
    if (!svgEl) return;
    
    try {
      // Clone the SVG to avoid modifying the original
      const clonedSvg = svgEl.cloneNode(true) as SVGElement;
      
      // Get intrinsic dimensions from the original SVG attributes or viewBox
      // This ensures we capture the full diagram regardless of current zoom/pan
      let width: number;
      let height: number;
      let viewBoxX = 0;
      let viewBoxY = 0;
      
      const viewBoxAttr = svgEl.getAttribute('viewBox');
      const widthAttr = svgEl.getAttribute('width');
      const heightAttr = svgEl.getAttribute('height');
      
      if (viewBoxAttr) {
        // Parse viewBox to get full diagram dimensions
        const parts = viewBoxAttr.split(/[\s,]+/).map(Number);
        if (parts.length === 4) {
          viewBoxX = parts[0];
          viewBoxY = parts[1];
          width = parts[2];
          height = parts[3];
        } else {
          // Fallback to getBBox
          const bbox = svgEl.getBBox();
          viewBoxX = bbox.x;
          viewBoxY = bbox.y;
          width = bbox.width;
          height = bbox.height;
        }
      } else if (widthAttr && heightAttr) {
        // Use explicit width/height attributes
        width = parseFloat(widthAttr) || 800;
        height = parseFloat(heightAttr) || 600;
      } else {
        // Fallback to getBBox for content bounds
        const bbox = svgEl.getBBox();
        viewBoxX = bbox.x;
        viewBoxY = bbox.y;
        width = bbox.width;
        height = bbox.height;
      }
      
      // Add padding
      const padding = 40;
      const totalWidth = Math.ceil(width + padding);
      const totalHeight = Math.ceil(height + padding);
      
      // Set proper dimensions on cloned SVG
      clonedSvg.setAttribute('width', String(totalWidth));
      clonedSvg.setAttribute('height', String(totalHeight));
      clonedSvg.setAttribute('viewBox', `${viewBoxX - padding/2} ${viewBoxY - padding/2} ${totalWidth} ${totalHeight}`);
      
      // Remove any transform that might have been applied for zoom/pan
      clonedSvg.style.transform = '';
      
      // Add white background
      const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bgRect.setAttribute('x', String(viewBoxX - padding/2));
      bgRect.setAttribute('y', String(viewBoxY - padding/2));
      bgRect.setAttribute('width', String(totalWidth));
      bgRect.setAttribute('height', String(totalHeight));
      bgRect.setAttribute('fill', 'white');
      clonedSvg.insertBefore(bgRect, clonedSvg.firstChild);
      
      // Serialize to string with proper XML declaration
      const serializer = new XMLSerializer();
      let svgString = serializer.serializeToString(clonedSvg);
      
      // Ensure proper namespace
      if (!svgString.includes('xmlns=')) {
        svgString = svgString.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      
      // Calculate optimal scale based on canvas size limits
      // Most browsers limit canvas to ~16384x16384 or ~268 megapixels
      const MAX_CANVAS_SIZE = 16384;
      const MAX_CANVAS_AREA = 268435456; // 256 megapixels to be safe
      
      let canvasScale = 2; // Default 2x for high quality
      
      // Check if dimensions exceed limits and reduce scale if needed
      let canvasWidth = totalWidth * canvasScale;
      let canvasHeight = totalHeight * canvasScale;
      
      // Reduce scale if dimensions exceed max size
      if (canvasWidth > MAX_CANVAS_SIZE || canvasHeight > MAX_CANVAS_SIZE) {
        const scaleByWidth = MAX_CANVAS_SIZE / totalWidth;
        const scaleByHeight = MAX_CANVAS_SIZE / totalHeight;
        canvasScale = Math.min(scaleByWidth, scaleByHeight, canvasScale);
      }
      
      // Reduce scale if total area exceeds limit
      canvasWidth = totalWidth * canvasScale;
      canvasHeight = totalHeight * canvasScale;
      if (canvasWidth * canvasHeight > MAX_CANVAS_AREA) {
        const areaScale = Math.sqrt(MAX_CANVAS_AREA / (totalWidth * totalHeight));
        canvasScale = Math.min(canvasScale, areaScale);
      }
      
      // Ensure minimum scale of 1
      canvasScale = Math.max(1, canvasScale);
      
      // Create canvas with calculated scale
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(totalWidth * canvasScale);
      canvas.height = Math.floor(totalHeight * canvasScale);
      
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      // Fill with white background
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(canvasScale, canvasScale);
      
      // Create image from SVG using data URL
      const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      
      const img = new Image();
      img.crossOrigin = 'anonymous';
      
      await new Promise<void>((resolve, reject) => {
        img.onload = () => {
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
          resolve();
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('Failed to load SVG image'));
        };
        img.src = url;
      });
      
      // Convert to PNG and download
      canvas.toBlob((blob) => {
        if (!blob) {
          console.error('Failed to create PNG blob');
          return;
        }
        const pngUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = pngUrl;
        a.download = 'er-diagram.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(pngUrl);
      }, 'image/png', 1.0);
      
    } catch (err) {
      console.error('PNG export failed:', err);
      // Fallback: try alternative method using canvas with inline SVG
      try {
        const fallbackCanvas = document.createElement('canvas');
        const fallbackCtx = fallbackCanvas.getContext('2d');
        if (!fallbackCtx) return;
        
        const rect = svgEl.getBoundingClientRect();
        fallbackCanvas.width = rect.width * 2;
        fallbackCanvas.height = rect.height * 2;
        fallbackCtx.fillStyle = 'white';
        fallbackCtx.fillRect(0, 0, fallbackCanvas.width, fallbackCanvas.height);
        fallbackCtx.scale(2, 2);
        
        // Use html2canvas-like approach with foreignObject
        const svgData = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
        const fallbackImg = new Image();
        fallbackImg.src = svgData;
        
        fallbackImg.onload = () => {
          fallbackCtx.drawImage(fallbackImg, 0, 0);
          fallbackCanvas.toBlob((blob) => {
            if (!blob) return;
            const pngUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = pngUrl;
            a.download = 'er-diagram.png';
            a.click();
            URL.revokeObjectURL(pngUrl);
          }, 'image/png');
        };
      } catch (fallbackErr) {
        console.error('Fallback PNG export also failed:', fallbackErr);
        alert('PNG export failed. Please try exporting as SVG instead.');
      }
    }
  }, [svg]);

  // Zoom handlers
  const zoomIn = useCallback(() => {
    setScale(s => Math.min(s * 1.25, 5));
  }, []);

  const zoomOut = useCallback(() => {
    setScale(s => Math.max(s / 1.25, 0.1));
  }, []);

  const resetView = useCallback(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, []);

  const fitToScreen = useCallback(() => {
    if (!svgContainerRef.current || !containerRef.current) return;
    const svgEl = svgContainerRef.current.querySelector('svg');
    if (!svgEl) return;
    
    const containerRect = containerRef.current.getBoundingClientRect();
    const svgRect = svgEl.getBoundingClientRect();
    const scaleX = (containerRect.width - 40) / (svgRect.width / scale);
    const scaleY = (containerRect.height - 40) / (svgRect.height / scale);
    const newScale = Math.min(scaleX, scaleY, 2);
    
    setScale(newScale);
    setPosition({ x: 0, y: 0 });
  }, [scale]);

  // Mouse drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  }, [position]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    setPosition({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  }, [isDragging, dragStart]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setScale(s => Math.min(Math.max(s * delta, 0.1), 5));
  }, []);

  // Fullscreen toggle
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen(f => !f);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isFullscreen) return;
      if (e.key === 'Escape') {
        setIsFullscreen(false);
      } else if (e.key === '+' || e.key === '=') {
        zoomIn();
      } else if (e.key === '-') {
        zoomOut();
      } else if (e.key === '0') {
        resetView();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen, zoomIn, zoomOut, resetView]);

  if (error) {
    return (
      <div className={`p-4 bg-red-50 dark:bg-red-900/20 rounded-lg ${className}`}>
        <p className="text-red-600 dark:text-red-400 text-sm">Error rendering diagram: {error}</p>
        <pre className="mt-2 text-xs text-slate-600 dark:text-slate-400 overflow-auto max-h-40">{chart}</pre>
      </div>
    );
  }

  const containerClasses = isFullscreen
    ? 'fixed inset-0 z-50 bg-white dark:bg-slate-900 flex flex-col'
    : `relative ${className}`;

  return (
    <div className={containerClasses}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 p-2 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 rounded-t-lg">
        <div className="flex items-center gap-1 bg-white dark:bg-slate-700 rounded-lg p-1 shadow-sm">
          <button
            onClick={zoomOut}
            className="p-2 hover:bg-slate-100 dark:hover:bg-slate-600 rounded transition-colors"
            title="Zoom Out (-)"
          >
            <svg className="w-4 h-4 text-slate-600 dark:text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>
          <span className="px-2 text-sm font-medium text-slate-600 dark:text-slate-300 min-w-[60px] text-center">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={zoomIn}
            className="p-2 hover:bg-slate-100 dark:hover:bg-slate-600 rounded transition-colors"
            title="Zoom In (+)"
          >
            <svg className="w-4 h-4 text-slate-600 dark:text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
        
        <button
          onClick={fitToScreen}
          className="p-2 bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 rounded-lg shadow-sm transition-colors"
          title="Fit to Screen"
        >
          <svg className="w-4 h-4 text-slate-600 dark:text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
        </button>

        <button
          onClick={resetView}
          className="p-2 bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 rounded-lg shadow-sm transition-colors"
          title="Reset View (0)"
        >
          <svg className="w-4 h-4 text-slate-600 dark:text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        <div className="flex-1" />

        {/* Export buttons */}
        <div className="flex items-center gap-1 bg-white dark:bg-slate-700 rounded-lg p-1 shadow-sm">
          <button
            onClick={handleExportSvg}
            className="px-2 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600 rounded transition-colors"
            title="Export as SVG"
          >
            SVG
          </button>
          <button
            onClick={handleExportPng}
            className="px-2 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600 rounded transition-colors"
            title="Export as PNG"
          >
            PNG
          </button>
        </div>

        <button
          onClick={toggleFullscreen}
          className="p-2 bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 rounded-lg shadow-sm transition-colors"
          title={isFullscreen ? 'Exit Fullscreen (Esc)' : 'Fullscreen'}
        >
          {isFullscreen ? (
            <svg className="w-4 h-4 text-slate-600 dark:text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="w-4 h-4 text-slate-600 dark:text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          )}
        </button>
      </div>

      {/* Diagram container */}
      <div
        ref={containerRef}
        className={`overflow-hidden bg-slate-50 dark:bg-slate-900 ${isFullscreen ? 'flex-1' : 'h-[600px]'} rounded-b-lg cursor-grab active:cursor-grabbing`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        <div
          ref={svgContainerRef}
          className="inline-block origin-top-left transition-transform duration-75"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      {/* Help text */}
      <div className="absolute bottom-4 left-4 text-xs text-slate-400 dark:text-slate-500 pointer-events-none">
        Scroll to zoom • Drag to pan • Click fullscreen for better view
      </div>
    </div>
  );
}
