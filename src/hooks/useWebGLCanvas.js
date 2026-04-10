// React hook that creates and manages the WebGPU renderer.
// Uses a dedicated Worker + OffscreenCanvas for GPU rendering.

import { useRef, useCallback, useEffect } from 'react';
import { hitTest } from '../webgl/hitTest.js';
import { TEXT_PAD_X, TEXT_PAD_Y, TEXT_LINE_HEIGHT, TEXT_DEFAULT_SIZE, FONT } from '../constants.js';

function textKey(item) {
  return `${item.id}|${item.type}|${item.text}|${item.fontSize}|${item.fontFamily}|${item.bold}|${item.italic}|${item.align}|${item.w}|${item.h}`;
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const para of text.split('\n')) {
    if (!para) { lines.push(''); continue; }
    let lineStart = 0;
    let lastBreakAfter = -1;
    for (let i = 0; i < para.length; i++) {
      const ch = para[i];
      if (ch === ' ' || ch === '\t') lastBreakAfter = i + 1;
      const segment = para.slice(lineStart, i + 1);
      const trimmedWidth = ctx.measureText(segment.trimEnd()).width;
      if (trimmedWidth > maxWidth && i > lineStart) {
        if (lastBreakAfter > lineStart) {
          lines.push(para.slice(lineStart, lastBreakAfter).trimEnd());
          lineStart = lastBreakAfter;
        } else {
          lines.push(para.slice(lineStart, i));
          lineStart = i;
        }
        lastBreakAfter = -1;
        i = lineStart - 1;
      }
    }
    const remaining = para.slice(lineStart);
    lines.push(remaining.trimEnd() || remaining);
  }
  return lines.length ? lines : [''];
}

export function useWebGLCanvas() {
  const canvasRef = useRef(null);
  const workerRef = useRef(null);
  const rafRef = useRef(0);
  const renderDataRef = useRef(null);
  const initRef = useRef(false);
  const textStateRef = useRef(new Map()); // itemId -> key
  const textCanvasRef = useRef(null);

  if (!textCanvasRef.current) textCanvasRef.current = document.createElement('canvas');

  const sendTextRaster = useCallback(async (item, key) => {
    const worker = workerRef.current;
    if (!worker || !item) return;

    const canvas = textCanvasRef.current;
    const ctx = canvas.getContext('2d');
    const scale = 0.5 + (window.devicePixelRatio || 1);
    const w = Math.max(1, Math.ceil(item.w * scale));
    const h = Math.max(1, Math.ceil(item.h * scale));

    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.scale(scale, scale);

    if (item.text) {
      const fontSize = item.fontSize || TEXT_DEFAULT_SIZE;
      const fontFamily = item.fontFamily || FONT;

      ctx.font = `${item.italic ? 'italic' : 'normal'} ${item.bold ? 'bold' : 'normal'} ${fontSize}px ${fontFamily}`;
      ctx.fillStyle = 'white';
      ctx.textBaseline = 'top';
      ctx.textAlign = item.align || 'left';

      const maxWidth = item.w - TEXT_PAD_X * 2;
      const lines = wrapText(ctx, item.text, maxWidth);
      const lineHeight = fontSize * TEXT_LINE_HEIGHT;
      const halfLeading = (lineHeight - fontSize) / 2;

      let x;
      if (item.align === 'center') x = item.w / 2;
      else if (item.align === 'right') x = item.w - TEXT_PAD_X;
      else x = TEXT_PAD_X;

      let startY = TEXT_PAD_Y + halfLeading;
      if (item.type === 'link') startY = (item.h - lines.length * lineHeight) / 2 + halfLeading;

      for (let i = 0; i < lines.length; i++) {
        const y = startY + i * lineHeight;
        if (y + lineHeight > item.h) break;
        ctx.fillText(lines[i], x, y);
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const bitmap = await createImageBitmap(canvas);
    worker.postMessage({ type: 'text-bitmap', item, key, bitmap, width: w, height: h }, [bitmap]);
  }, []);

  const initRenderer = useCallback((canvas) => {
    if (!canvas || initRef.current) return;
    initRef.current = true;

    const worker = new Worker(new URL('../workers/webgpuWorker.js', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === 'request-text-raster') {
        sendTextRaster(msg.item, msg.key);
      }
    };

    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ type: 'init', canvas: offscreen, dpr: window.devicePixelRatio || 1 }, [offscreen]);

    if (renderDataRef.current) {
      worker.postMessage({ type: 'render', data: renderDataRef.current });
    }
  }, [sendTextRaster]);

  const setCanvasRef = useCallback((el) => {
    canvasRef.current = el;
    if (el) initRenderer(el);
  }, [initRenderer]);

  const pushTextUpdates = useCallback((data) => {
    const items = data?.items || [];
    for (const item of items) {
      if (item.type !== 'text' && item.type !== 'link') continue;
      const key = textKey(item);
      if (textStateRef.current.get(item.id) === key) continue;
      textStateRef.current.set(item.id, key);
      sendTextRaster(item, key);
    }
  }, [sendTextRaster]);

  const requestRender = useCallback((data) => {
    const host = canvasRef.current;
    const payload = {
      ...data,
      cssWidth: host?.clientWidth || data.cssWidth || 0,
      cssHeight: host?.clientHeight || data.cssHeight || 0,
    };
    renderDataRef.current = payload;
    pushTextUpdates(payload);
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const worker = workerRef.current;
        const d = renderDataRef.current;
        if (worker && d) worker.postMessage({ type: 'render', data: d });
      });
    }
  }, [pushTextUpdates]);

  const renderSync = useCallback((data) => {
    const host = canvasRef.current;
    const payload = {
      ...data,
      cssWidth: host?.clientWidth || data.cssWidth || 0,
      cssHeight: host?.clientHeight || data.cssHeight || 0,
    };
    renderDataRef.current = payload;
    pushTextUpdates(payload);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    const worker = workerRef.current;
    if (worker) worker.postMessage({ type: 'render', data: payload });
  }, [pushTextUpdates]);

  const doHitTest = useCallback((screenX, screenY, items, panX, panY, zoom) => {
    return hitTest(screenX, screenY, items, panX, panY, zoom);
  }, []);

  const invalidateText = useCallback((itemId) => {
    textStateRef.current.delete(itemId);
    const worker = workerRef.current;
    if (worker) worker.postMessage({ type: 'invalidate-text', itemId });
  }, []);

  const rendererRef = useRef(null);

  useEffect(() => {
    const onResize = () => {
      const d = renderDataRef.current;
      if (d) requestRender(d);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'destroy' });
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, [requestRender]);

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
