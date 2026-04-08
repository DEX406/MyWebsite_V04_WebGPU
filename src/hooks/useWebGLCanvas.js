// React hook that creates and manages the WebGL renderer.
// Replaces the DOM-based content layer with a single WebGL canvas.

import { useRef, useCallback, useEffect } from 'react';
import { GLRenderer } from '../webgl/GLRenderer.js';
import { hitTest } from '../webgl/hitTest.js';
import { GOOGLE_FONT_STYLESHEETS } from '../fontLibrary.js';

function getCanvasSize(canvas) {
  const rect = canvas?.getBoundingClientRect?.();
  return {
    width: Math.max(1, Math.round(rect?.width || canvas?.clientWidth || 1)),
    height: Math.max(1, Math.round(rect?.height || canvas?.clientHeight || 1)),
  };
}

export function useWebGLCanvas() {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const workerRef = useRef(null);
  const modeRef = useRef(null); // 'worker' | 'main'
  const rafRef = useRef(0);
  const renderDataRef = useRef(null);

  const initMainRenderer = useCallback((canvas) => {
    if (!canvas || rendererRef.current) return;
    const renderer = new GLRenderer(canvas);
    renderer._onNeedsRedraw = () => {
      const d = renderDataRef.current;
      if (!d) return;
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          if (rendererRef.current && renderDataRef.current) {
            rendererRef.current.render(renderDataRef.current);
          }
        });
      }
    };
    rendererRef.current = renderer;
  }, []);

  const initWorkerRenderer = useCallback((canvas) => {
    if (!canvas || workerRef.current) return;
    if (typeof Worker === 'undefined' || typeof canvas.transferControlToOffscreen !== 'function') return;

    const worker = new Worker(new URL('../workers/webglWorker.js', import.meta.url), { type: 'module' });
    const offscreen = canvas.transferControlToOffscreen();
    const { width, height } = getCanvasSize(canvas);
    worker.postMessage({
      type: 'init',
      canvas: offscreen,
      width,
      height,
      dpr: window.devicePixelRatio || 1,
      fontStylesheets: GOOGLE_FONT_STYLESHEETS,
    }, [offscreen]);
    workerRef.current = worker;
  }, []);

  const ensureRenderer = useCallback((data) => {
    if (modeRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const hasVideo = !!data?.items?.some(i => i.type === 'video');
    const canUseWorker = !hasVideo && typeof Worker !== 'undefined' && typeof canvas.transferControlToOffscreen === 'function';

    if (canUseWorker) {
      initWorkerRenderer(canvas);
      if (workerRef.current) {
        modeRef.current = 'worker';
        return;
      }
    }

    initMainRenderer(canvas);
    modeRef.current = 'main';
  }, [initMainRenderer, initWorkerRenderer]);

  // Set the canvas ref and init
  const setCanvasRef = useCallback((el) => {
    canvasRef.current = el;
  }, []);

  const postRenderToWorker = useCallback((type, data) => {
    const worker = workerRef.current;
    const canvas = canvasRef.current;
    if (!worker || !canvas) return;
    const { width, height } = getCanvasSize(canvas);
    worker.postMessage({
      type,
      data,
      width,
      height,
      dpr: window.devicePixelRatio || 1,
    });
  }, []);

  // Schedule a render with the latest data
  const requestRender = useCallback((data) => {
    renderDataRef.current = data;
    ensureRenderer(data);

    if (modeRef.current === 'worker') {
      postRenderToWorker('render', data);
      return;
    }

    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const renderer = rendererRef.current;
        const d = renderDataRef.current;
        if (renderer && d) {
          renderer.render(d);
        }
      });
    }
  }, [ensureRenderer, postRenderToWorker]);

  // Synchronous render (for inside existing rAF, e.g. animateTo)
  const renderSync = useCallback((data) => {
    renderDataRef.current = data;
    ensureRenderer(data);

    if (modeRef.current === 'worker') {
      postRenderToWorker('renderSync', data);
      return;
    }

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    const renderer = rendererRef.current;
    if (renderer && data) {
      renderer.render(data);
    }
  }, [ensureRenderer, postRenderToWorker]);

  // Hit test at screen coordinates (relative to canvas)
  const doHitTest = useCallback((screenX, screenY, items, panX, panY, zoom) => {
    return hitTest(screenX, screenY, items, panX, panY, zoom);
  }, []);

  // Invalidate a text item's cached texture
  const invalidateText = useCallback((itemId) => {
    if (modeRef.current === 'worker') {
      workerRef.current?.postMessage({ type: 'invalidateText', itemId });
      return;
    }
    const renderer = rendererRef.current;
    if (renderer) renderer.textRenderer.invalidate(itemId);
  }, []);

  const invalidateAllText = useCallback(() => {
    if (modeRef.current === 'worker') {
      workerRef.current?.postMessage({ type: 'invalidateAllText' });
      return;
    }
    const renderer = rendererRef.current;
    if (renderer) renderer.textRenderer.invalidateAll();
  }, []);

  // Cleanup
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'destroy' });
        workerRef.current.terminate();
        workerRef.current = null;
      }
      if (rendererRef.current) {
        rendererRef.current.destroy();
        rendererRef.current = null;
      }
    };
  }, []);

  return {
    setCanvasRef,
    canvasRef,
    rendererRef,
    requestRender,
    renderSync,
    doHitTest,
    invalidateText,
    invalidateAllText,
  };
}
