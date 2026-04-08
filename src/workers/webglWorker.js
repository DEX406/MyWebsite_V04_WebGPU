import { GLRenderer } from '../webgl/GLRenderer.js';

let renderer = null;
let pendingData = null;
let rafId = 0;

function scheduleRender() {
  if (rafId) return;
  rafId = self.requestAnimationFrame(() => {
    rafId = 0;
    if (!renderer || !pendingData) return;
    renderer.render(pendingData);
  });
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === 'init') {
    const { canvas, width, height, dpr } = msg;
    renderer = new GLRenderer(canvas, {
      isOffscreen: true,
      initialWidth: width,
      initialHeight: height,
      initialDpr: dpr,
      onNeedsRedraw: () => scheduleRender(),
    });
    return;
  }

  if (!renderer) return;

  if (msg.type === 'render') {
    pendingData = msg.data;
    renderer.setViewport(msg.width, msg.height, msg.dpr);
    scheduleRender();
    return;
  }

  if (msg.type === 'renderSync') {
    pendingData = msg.data;
    renderer.setViewport(msg.width, msg.height, msg.dpr);
    renderer.render(pendingData);
    return;
  }

  if (msg.type === 'invalidateText') {
    renderer.textRenderer.invalidate(msg.itemId);
    return;
  }

  if (msg.type === 'invalidateAllText') {
    renderer.textRenderer.invalidateAll();
    return;
  }

  if (msg.type === 'destroy') {
    if (rafId) {
      self.cancelAnimationFrame(rafId);
      rafId = 0;
    }
    renderer.destroy();
    renderer = null;
    pendingData = null;
  }
};
