// Renders text items to offscreen Canvas2D alpha-mask textures.
// Only the glyph shape is baked in; color and background are shader uniforms.
// Caches based on properties that affect glyph shape only.

import { TEXT_PAD_X, TEXT_PAD_Y, TEXT_LINE_HEIGHT, TEXT_DEFAULT_SIZE, FONT } from '../constants.js';

export class TextRenderer {
  constructor(gl, onTextureReady) {
    this.gl = gl;
    this.cache = new Map();    // key → { tex, width, height, lastUsed }
    this.itemKeys = new Map(); // itemId → current cache key (1 live texture per item)
    this.pending = new Map();  // itemId → { item, key, epoch }
    this.isInteracting = false;
    this.requestEpoch = 0;
    this._raf = 0;
    this._onTextureReady = onTextureReady || null;
    this.maxBuildsPerFrame = 2;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.transparent = this._createTransparentTexture();
  }

  _createTransparentTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, width: 1, height: 1 };
  }

  setInteractionState(interacting) {
    if (interacting && !this.isInteracting) {
      this.requestEpoch += 1;
      this.pending.clear();
      if (this._raf) {
        cancelAnimationFrame(this._raf);
        this._raf = 0;
      }
    }
    this.isInteracting = interacting;
    if (!interacting) this._scheduleBuild();
  }

  _scheduleBuild() {
    if (this._raf || this.isInteracting || this.pending.size === 0) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._pumpBuildQueue();
    });
  }

  _pumpBuildQueue() {
    if (this.isInteracting || this.pending.size === 0) return;
    let built = 0;
    for (const [itemId, req] of this.pending) {
      this.pending.delete(itemId);
      if (req.epoch !== this.requestEpoch) continue;
      if (this.cache.has(req.key)) continue;
      const entry = this._render(req.item);
      entry.lastUsed = performance.now();
      this.cache.set(req.key, entry);
      this.itemKeys.set(req.item.id, req.key);
      if (this.cache.size > 200) this._evict();
      built += 1;
      if (this._onTextureReady) this._onTextureReady();
      if (built >= this.maxBuildsPerFrame) break;
    }
    if (this.pending.size > 0) this._scheduleBuild();
  }

  // Cache key covers only what affects glyph shape.
  // Color, bgColor, bgOpacity are now shader uniforms — no texture re-upload needed when they change.
  _key(item) {
    return `${item.id}|${item.type}|${item.text}|${item.fontSize}|${item.fontFamily}|${item.bold}|${item.italic}|${item.align}|${item.w}|${item.h}`;
  }

  // Get or create a texture for a text/link item.
  // Returns { tex, width, height }
  get(item) {
    const key = this._key(item);

    // If this item's properties changed, immediately free the old GPU texture
    const prevKey = this.itemKeys.get(item.id);
    if (prevKey && prevKey !== key) {
      const old = this.cache.get(prevKey);
      if (old) {
        this.gl.deleteTexture(old.tex);
        this.cache.delete(prevKey);
      }
    }

    const cached = this.cache.get(key);
    if (cached) {
      cached.lastUsed = performance.now();
      this.itemKeys.set(item.id, key);
      return cached;
    }

    // Defer expensive text rasterization and spread it over frames.
    const pendingReq = this.pending.get(item.id);
    if (!pendingReq || pendingReq.key !== key) {
      this.pending.set(item.id, { item: { ...item }, key, epoch: this.requestEpoch });
    }
    this._scheduleBuild();
    return this.transparent;
  }

  _render(item) {
    const gl = this.gl;
    const scale = 4 + (window.devicePixelRatio || 1);
    const w = Math.ceil(item.w * scale);
    const h = Math.ceil(item.h * scale);

    this.canvas.width = w;
    this.canvas.height = h;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, w, h);
    ctx.scale(scale, scale);

    // Render glyph mask only — white text on transparent background.
    // Color and background are applied later as shader uniforms (no rebake needed when they change).
    if (item.text) {
      const fontSize = item.fontSize || TEXT_DEFAULT_SIZE;
      const fontFamily = item.fontFamily || FONT;

      ctx.font = `${item.italic ? 'italic' : 'normal'} ${item.bold ? 'bold' : 'normal'} ${fontSize}px ${fontFamily}`;
      ctx.fillStyle = 'white';
      ctx.textBaseline = 'top';
      ctx.textAlign = item.align || 'left';

      const maxWidth = item.w - TEXT_PAD_X * 2;
      const lines = this._wrapText(ctx, item.text, maxWidth);
      const lineHeight = fontSize * TEXT_LINE_HEIGHT;

      // CSS distributes (lineHeight - fontSize) as half-leading above and below each line.
      // textBaseline='top' sits at the em-square top with no leading, so we must add
      // the half-leading offset to match where CSS places the first character.
      const halfLeading = (lineHeight - fontSize) / 2;

      let x;
      if (item.align === 'center') x = item.w / 2;
      else if (item.align === 'right') x = item.w - TEXT_PAD_X;
      else x = TEXT_PAD_X;

      let startY = TEXT_PAD_Y + halfLeading;
      if (item.type === 'link') {
        startY = (item.h - lines.length * lineHeight) / 2 + halfLeading;
      }

      for (let i = 0; i < lines.length; i++) {
        const y = startY + i * lineHeight;
        if (y + lineHeight > item.h) break;
        ctx.fillText(lines[i], x, y);
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Upload canvas directly — the browser transfers it GPU-side without any CPU readback.
    // The alpha channel carries the glyph mask; sampled as .a in the shader.
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return { tex, width: w, height: h };
  }

  // Wrap text to match CSS `white-space: pre-wrap; word-break: break-word; overflow: hidden`.
  // Key CSS rule: trailing whitespace at end-of-line "hangs" — it does NOT count toward
  // the line width when deciding whether to wrap. We replicate this by measuring only the
  // trimmed (no trailing spaces) width against maxWidth.
  _wrapText(ctx, text, maxWidth) {
    const lines = [];
    for (const para of text.split('\n')) {
      if (!para) { lines.push(''); continue; }

      let lineStart = 0;
      let lastBreakAfter = -1; // index *after* the last break-opportunity char

      for (let i = 0; i < para.length; i++) {
        const ch = para[i];

        // Spaces and tabs are break opportunities (break is allowed after them)
        if (ch === ' ' || ch === '\t') {
          lastBreakAfter = i + 1;
        }

        // Measure from lineStart to i+1, trimming trailing whitespace (CSS "hang" rule)
        const segment = para.slice(lineStart, i + 1);
        const trimmedWidth = ctx.measureText(segment.trimEnd()).width;

        if (trimmedWidth > maxWidth && i > lineStart) {
          if (lastBreakAfter > lineStart) {
            // Wrap at last whitespace break opportunity
            lines.push(para.slice(lineStart, lastBreakAfter).trimEnd());
            lineStart = lastBreakAfter;
            // Skip past any whitespace at start of new line (CSS pre-wrap consumes
            // the break-space; remaining spaces start the new line)
          } else {
            // No break opportunity — break at current char (word-break: break-word)
            lines.push(para.slice(lineStart, i));
            lineStart = i;
          }
          lastBreakAfter = -1;
          // Re-check current char on the new line
          i = lineStart - 1;
        }
      }

      // Push remaining text for this paragraph
      const remaining = para.slice(lineStart);
      lines.push(remaining.trimEnd() || remaining);
    }
    return lines.length ? lines : [''];
  }

  _evict() {
    // Remove oldest 50 entries
    const entries = [...this.cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const toRemove = entries.slice(0, 50);
    for (const [key, entry] of toRemove) {
      this.gl.deleteTexture(entry.tex);
      this.cache.delete(key);
    }
  }

  // Invalidate a specific item's cached texture immediately
  invalidate(itemId) {
    const key = this.itemKeys.get(itemId);
    if (key) {
      const entry = this.cache.get(key);
      if (entry) {
        this.gl.deleteTexture(entry.tex);
        this.cache.delete(key);
      }
      this.itemKeys.delete(itemId);
    }
    this.pending.delete(itemId);
  }

  // Invalidate every cached texture — use when fonts finish loading
  invalidateAll() {
    for (const entry of this.cache.values()) this.gl.deleteTexture(entry.tex);
    this.cache.clear();
    this.itemKeys.clear();
    this.pending.clear();
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    for (const entry of this.cache.values()) {
      this.gl.deleteTexture(entry.tex);
    }
    this.gl.deleteTexture(this.transparent.tex);
    this.cache.clear();
    this.itemKeys.clear();
    this.pending.clear();
  }
}
