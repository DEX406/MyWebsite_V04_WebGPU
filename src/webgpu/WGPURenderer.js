import { TEXT_PAD_X, TEXT_PAD_Y, TEXT_LINE_HEIGHT, TEXT_DEFAULT_SIZE, FONT } from '../constants.js';
import { hexToRgb } from '../utils.js';

const SUPERSAMPLE = 2;

const PRESENT_WGSL = `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsMain(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(
    vec2f(-1.0, -3.0),
    vec2f(-1.0,  1.0),
    vec2f( 3.0,  1.0)
  );

  var out: VsOut;
  out.pos = vec4f(p[vi], 0.0, 1.0);
  out.uv = (out.pos.xy * 0.5) + vec2f(0.5, 0.5);
  return out;
}

@group(0) @binding(0) var sceneTex: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;

@fragment
fn fsMain(in: VsOut) -> @location(0) vec4f {
  return textureSample(sceneTex, sceneSampler, in.uv);
}
`;

function makeVideo(src) {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.autoplay = true;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.src = src;
  video.play().catch(() => {});
  return video;
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r || 0, Math.min(w, h) / 2));
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export class WGPURenderer {
  static async create(canvas) {
    if (!navigator.gpu) throw new Error('WebGPU not supported in this browser');

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter available');

    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Failed to get webgpu context');

    return new WGPURenderer(canvas, device, context);
  }

  constructor(canvas, device, context) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();

    this.offscreen = document.createElement('canvas');
    this.ctx2d = this.offscreen.getContext('2d', { alpha: false });

    this.imageCache = new Map();
    this.videoCache = new Map();

    this.sceneTexture = null;
    this.sceneTextureView = null;

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: PRESENT_WGSL }),
        entryPoint: 'vsMain',
      },
      fragment: {
        module: this.device.createShaderModule({ code: PRESENT_WGSL }),
        entryPoint: 'fsMain',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.bindGroup = null;
    this.textRenderer = { invalidate() {}, invalidateAll() {} };
  }

  _ensureConfigured() {
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'opaque',
    });
  }

  resize() {
    const dpr = (window.devicePixelRatio || 1) * SUPERSAMPLE;
    const parent = this.canvas.parentElement;
    if (!parent) return;

    const cssW = parent.clientWidth;
    const cssH = parent.clientHeight;

    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;

    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));

    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }

    if (this.offscreen.width !== pw || this.offscreen.height !== ph) {
      this.offscreen.width = pw;
      this.offscreen.height = ph;
      this._recreateSceneTexture();
    }
  }

  _recreateSceneTexture() {
    if (this.sceneTexture) this.sceneTexture.destroy();

    this.sceneTexture = this.device.createTexture({
      size: [this.offscreen.width, this.offscreen.height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.sceneTextureView = this.sceneTexture.createView();

    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sceneTextureView },
        { binding: 1, resource: this.sampler },
      ],
    });
  }

  _getImage(src) {
    if (!src) return null;
    const cached = this.imageCache.get(src);
    if (cached) return cached;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src;
    const entry = { img, ready: false };
    img.onload = () => { entry.ready = true; };
    img.onerror = () => { entry.ready = false; };
    this.imageCache.set(src, entry);
    return entry;
  }

  _getVideo(itemId, src) {
    if (!src) return null;
    const cached = this.videoCache.get(itemId);
    if (cached && cached.src === src) return cached.video;

    if (cached) {
      cached.video.pause();
      cached.video.src = '';
      this.videoCache.delete(itemId);
    }

    const video = makeVideo(src);
    this.videoCache.set(itemId, { src, video });
    return video;
  }

  _drawGrid(bgGrid, panX, panY, zoom) {
    if (!bgGrid?.enabled) return;
    const ctx = this.ctx2d;
    const d1 = bgGrid.dot1;
    const d2 = bgGrid.dot2;

    const drawDotLayer = (dot) => {
      if (!dot) return;
      const spacing = Math.max(4, dot.spacing || 20);
      const radius = Math.max(0.2, dot.size || 1);
      const alpha = Math.max(0, Math.min(1, dot.opacity ?? 0.2));
      const color = `rgba(${Math.round((hexToRgb(dot.color || '#fff')[0]) * 255)}, ${Math.round((hexToRgb(dot.color || '#fff')[1]) * 255)}, ${Math.round((hexToRgb(dot.color || '#fff')[2]) * 255)}, ${alpha})`;

      const worldLeft = -panX / zoom;
      const worldTop = -panY / zoom;
      const worldRight = (this.offscreen.width / ((window.devicePixelRatio || 1) * SUPERSAMPLE) - panX) / zoom;
      const worldBottom = (this.offscreen.height / ((window.devicePixelRatio || 1) * SUPERSAMPLE) - panY) / zoom;

      const startX = Math.floor(worldLeft / spacing) * spacing;
      const startY = Math.floor(worldTop / spacing) * spacing;

      ctx.fillStyle = color;
      for (let x = startX; x <= worldRight + spacing; x += spacing) {
        for (let y = startY; y <= worldBottom + spacing; y += spacing) {
          const sx = x * zoom + panX;
          const sy = y * zoom + panY;
          ctx.beginPath();
          ctx.arc(sx, sy, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    const fade = zoom >= 1 ? 1 : zoom <= 0.5 ? 0 : (zoom - 0.5) / 0.5;
    if (fade > 0) {
      if (d1) drawDotLayer({ ...d1, opacity: (d1.opacity ?? 0.2) * fade });
      if (d2?.enabled) drawDotLayer({ ...d2, opacity: (d2.opacity ?? 0.2) * fade });
    }
  }

  _coverDraw(image, x, y, w, h) {
    const iw = image.videoWidth || image.naturalWidth || image.width || 1;
    const ih = image.videoHeight || image.naturalHeight || image.height || 1;
    const ir = iw / ih;
    const r = w / h;

    let sx = 0;
    let sy = 0;
    let sw = iw;
    let sh = ih;

    if (ir > r) {
      sw = ih * r;
      sx = (iw - sw) / 2;
    } else {
      sh = iw / r;
      sy = (ih - sh) / 2;
    }

    this.ctx2d.drawImage(image, sx, sy, sw, sh, x, y, w, h);
  }

  _wrapText(ctx, text, maxWidth) {
    const lines = [];
    for (const para of String(text || '').split('\n')) {
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

  _drawItem(item, globalShadow, editingTextId) {
    if (editingTextId === item.id && item.type !== 'text' && item.type !== 'link') return;

    const ctx = this.ctx2d;
    const x = item.x;
    const y = item.y;
    const w = item.w;
    const h = item.h;
    const radius = item.radius ?? 2;

    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(((item.rotation || 0) * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);

    if (globalShadow?.enabled && item.type !== 'connector') {
      ctx.shadowColor = `rgba(0,0,0,${globalShadow.opacity ?? 0.1})`;
      ctx.shadowBlur = (globalShadow.size || 1.5) * 8;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    } else {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }

    roundedRectPath(ctx, 0, 0, w, h, radius);
    ctx.fillStyle = item.bgColor || item.color || 'rgba(0,0,0,0)';
    const bgOpacity = item.bgOpacity ?? 1;
    ctx.globalAlpha = bgOpacity;
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    if ((item.borderWidth || 0) > 0) {
      roundedRectPath(ctx, 0, 0, w, h, radius);
      ctx.lineWidth = item.borderWidth;
      ctx.strokeStyle = item.borderColor || '#000000';
      ctx.stroke();
    }

    if (item.type === 'image') {
      const img = this._getImage(item.displaySrc || item.src || item.targetSrc || item.placeholderSrc);
      if (img?.ready) {
        ctx.save();
        roundedRectPath(ctx, 0, 0, w, h, radius);
        ctx.clip();
        this._coverDraw(img.img, 0, 0, w, h);
        ctx.restore();
      }
    }

    if (item.type === 'video') {
      const video = this._getVideo(item.id, item.src);
      if (video && video.readyState >= 2) {
        ctx.save();
        roundedRectPath(ctx, 0, 0, w, h, radius);
        ctx.clip();
        this._coverDraw(video, 0, 0, w, h);
        ctx.restore();
      }
    }

    if ((item.type === 'text' || item.type === 'link') && item.text) {
      const fontSize = item.fontSize || TEXT_DEFAULT_SIZE;
      const fontFamily = item.fontFamily || FONT;
      ctx.font = `${item.italic ? 'italic' : 'normal'} ${item.bold ? 'bold' : 'normal'} ${fontSize}px ${fontFamily}`;
      ctx.fillStyle = item.color || '#ffffff';
      ctx.textBaseline = 'top';
      ctx.textAlign = item.align || 'left';

      const maxWidth = w - TEXT_PAD_X * 2;
      const lines = this._wrapText(ctx, item.text, maxWidth);
      const lineHeight = fontSize * TEXT_LINE_HEIGHT;
      const halfLeading = (lineHeight - fontSize) / 2;

      let tx;
      if (item.align === 'center') tx = w / 2;
      else if (item.align === 'right') tx = w - TEXT_PAD_X;
      else tx = TEXT_PAD_X;

      let startY = TEXT_PAD_Y + halfLeading;
      if (item.type === 'link') startY = (h - lines.length * lineHeight) / 2 + halfLeading;

      for (let i = 0; i < lines.length; i++) {
        const ty = startY + i * lineHeight;
        if (ty + lineHeight > h) break;
        ctx.fillText(lines[i], tx, ty);
      }
    }

    ctx.restore();
  }

  _drawConnector(item) {
    const ctx = this.ctx2d;
    const x1 = item.x1;
    const y1 = item.y1;
    const x2 = item.x2;
    const y2 = item.y2;
    const elbowX = item.elbowX ?? (x1 + x2) / 2;
    const elbowY = item.elbowY ?? (y1 + y2) / 2;
    const orient = item.orientation || 'h';

    ctx.save();
    ctx.strokeStyle = item.lineColor || '#C2C0B6';
    ctx.lineWidth = item.lineWidth || 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    if (orient === 'h') {
      ctx.lineTo(elbowX, y1);
      ctx.lineTo(elbowX, y2);
    } else {
      ctx.lineTo(x1, elbowY);
      ctx.lineTo(x2, elbowY);
    }
    ctx.lineTo(x2, y2);
    ctx.stroke();

    const dotRadius = item.dotRadius || 5;
    ctx.fillStyle = item.dotColor || item.lineColor || '#C2C0B6';
    ctx.beginPath();
    ctx.arc(x1, y1, dotRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x2, y2, dotRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  _drawSelection(item) {
    if (item.type === 'connector') return;
    const ctx = this.ctx2d;

    ctx.save();
    ctx.translate(item.x + item.w / 2, item.y + item.h / 2);
    ctx.rotate(((item.rotation || 0) * Math.PI) / 180);
    ctx.translate(-item.w / 2, -item.h / 2);

    roundedRectPath(ctx, -1.5, -1.5, item.w + 3, item.h + 3, (item.radius ?? 2) + 1.5);
    ctx.strokeStyle = 'rgba(44,132,219,0.7)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();
  }

  render({ items, panX, panY, zoom, bgGrid, globalShadow, selectedIds, editingTextId }) {
    this.resize();
    this._ensureConfigured();

    const dpr = (window.devicePixelRatio || 1) * SUPERSAMPLE;
    const ctx = this.ctx2d;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.offscreen.width, this.offscreen.height);

    ctx.scale(dpr, dpr);

    const bg = bgGrid?.bgColor || '#141413';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.offscreen.width / dpr, this.offscreen.height / dpr);

    this._drawGrid(bgGrid, panX, panY, zoom);

    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    const sorted = [...items].sort((a, b) => a.z - b.z);
    for (const item of sorted) {
      if (item.type === 'connector') this._drawConnector(item);
      else this._drawItem(item, globalShadow, editingTextId);
    }

    const sel = new Set(selectedIds || []);
    for (const item of sorted) {
      if (sel.has(item.id)) this._drawSelection(item);
    }
    ctx.restore();

    this.device.queue.copyExternalImageToTexture(
      { source: this.offscreen },
      { texture: this.sceneTexture },
      [this.offscreen.width, this.offscreen.height]
    );

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();

    this.device.queue.submit([encoder.finish()]);
  }

  destroy() {
    for (const entry of this.videoCache.values()) {
      entry.video.pause();
      entry.video.src = '';
    }
    this.videoCache.clear();
    this.imageCache.clear();
    if (this.sceneTexture) {
      this.sceneTexture.destroy();
      this.sceneTexture = null;
    }
  }
}
