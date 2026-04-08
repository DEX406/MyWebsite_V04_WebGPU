import { GLRenderer } from '../webgl/GLRenderer.js';

let renderer = null;
let pendingData = null;
let rafId = 0;

function firstMatch(text, regex, fallback = '') {
  const m = text.match(regex);
  return m?.[1] ?? fallback;
}

async function loadWorkerFonts(stylesheets = []) {
  if (typeof self.fonts === 'undefined' || typeof FontFace === 'undefined') return;
  const loaded = new Set();

  for (const sheetUrl of stylesheets) {
    try {
      const css = await fetch(sheetUrl).then(r => r.text());
      const blocks = css.match(/@font-face\s*{[^}]+}/g) || [];
      for (const block of blocks) {
        const family = firstMatch(block, /font-family:\s*['"]?([^;'"]+)['"]?\s*;/, '');
        const rawUrl = firstMatch(block, /url\(([^)]+)\)/, '').trim().replace(/^['"]|['"]$/g, '');
        if (!family || !rawUrl) continue;
        const source = rawUrl.startsWith('http') ? rawUrl : new URL(rawUrl, sheetUrl).href;
        const style = firstMatch(block, /font-style:\s*([^;]+);/, 'normal').trim();
        const weight = firstMatch(block, /font-weight:\s*([^;]+);/, '400').trim();
        const key = `${family}|${style}|${weight}|${source}`;
        if (loaded.has(key)) continue;
        loaded.add(key);
        const face = new FontFace(family, `url(${source})`, { style, weight });
        await face.load();
        self.fonts.add(face);
      }
    } catch {
      // best effort only
    }
  }

  await self.fonts.ready;
}

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
    const { canvas, width, height, dpr, fontStylesheets } = msg;
    renderer = new GLRenderer(canvas, {
      isOffscreen: true,
      initialWidth: width,
      initialHeight: height,
      initialDpr: dpr,
      onNeedsRedraw: () => scheduleRender(),
    });
    loadWorkerFonts(fontStylesheets).then(() => {
      if (!renderer) return;
      renderer.textRenderer.invalidateAll();
      if (pendingData) scheduleRender();
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
