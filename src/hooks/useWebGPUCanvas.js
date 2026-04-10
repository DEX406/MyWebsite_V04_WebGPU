import { useRef, useCallback, useEffect } from 'react';
import { WGPURenderer } from '../webgpu/WGPURenderer.js';
import { hitTest } from '../webgpu/hitTest.js';

export function useWebGPUCanvas() {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const rafRef = useRef(0);
  const renderDataRef = useRef(null);
  const initPromiseRef = useRef(null);

  const initRenderer = useCallback(async (canvas) => {
    if (!canvas || rendererRef.current || initPromiseRef.current) return;
    initPromiseRef.current = (async () => {
      try {
        const renderer = await WGPURenderer.create(canvas);
        rendererRef.current = renderer;
        if (renderDataRef.current) renderer.render(renderDataRef.current);
      } catch (e) {
        console.error('Failed to create WebGPU renderer:', e);
      } finally {
        initPromiseRef.current = null;
      }
    })();
  }, []);

  const setCanvasRef = useCallback((el) => {
    canvasRef.current = el;
    if (el) initRenderer(el);
  }, [initRenderer]);

  const requestRender = useCallback((data) => {
    renderDataRef.current = data;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const renderer = rendererRef.current;
        const d = renderDataRef.current;
        if (renderer && d) renderer.render(d);
      });
    }
  }, []);

  const renderSync = useCallback((data) => {
    renderDataRef.current = data;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    const renderer = rendererRef.current;
    if (renderer && data) renderer.render(data);
  }, []);

  const doHitTest = useCallback((screenX, screenY, items, panX, panY, zoom) => (
    hitTest(screenX, screenY, items, panX, panY, zoom)
  ), []);

  const invalidateText = useCallback((itemId) => {
    const renderer = rendererRef.current;
    if (renderer) renderer.textRenderer.invalidate(itemId);
  }, []);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (rendererRef.current) {
      rendererRef.current.destroy();
      rendererRef.current = null;
    }
  }, []);

  return {
    setCanvasRef,
    canvasRef,
    rendererRef,
    requestRender,
    renderSync,
    doHitTest,
    invalidateText,
  };
}
