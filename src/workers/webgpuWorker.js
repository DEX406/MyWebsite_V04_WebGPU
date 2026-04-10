import { GPURenderer } from '../webgpu/GPURenderer.js';

let renderer = null;

self.onmessage = async (ev) => {
  const msg = ev.data;

  if (msg.type === 'init') {
    if (!navigator.gpu) return;
    const canvas = msg.canvas;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return;
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });

    renderer = new GPURenderer(canvas, device, context, {
      devicePixelRatio: msg.dpr || 1,
      requestTextRaster: (item, key) => {
        self.postMessage({ type: 'request-text-raster', item, key });
      },
    });
    return;
  }

  if (!renderer) return;

  if (msg.type === 'render') {
    renderer.render(msg.data);
  } else if (msg.type === 'text-bitmap') {
    renderer.uploadTextBitmap(msg);
    if (msg.bitmap && typeof msg.bitmap.close === 'function') msg.bitmap.close();
  } else if (msg.type === 'invalidate-text') {
    renderer.textRenderer.invalidate(msg.itemId);
  } else if (msg.type === 'destroy') {
    renderer.destroy();
    renderer = null;
  }
};
