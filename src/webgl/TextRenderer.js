// Renders text items to offscreen Canvas2D alpha-mask textures.
// Only the glyph shape is baked in; color and background are shader uniforms.
// Caches based on properties that affect glyph shape only.

export class TextRenderer {
  constructor(gl) {
    this.gl = gl;
    this.cache = new Map();    // key → { tex, width, height, lastUsed }
    this.itemKeys = new Map(); // itemId → current cache key (1 live texture per item)
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
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

    const entry = this._render(item);
    entry.lastUsed = performance.now();
    this.cache.set(key, entry);
    this.itemKeys.set(item.id, key);

    // Evict old entries if cache is large
    if (this.cache.size > 200) this._evict();

    return entry;
  }

  _render(item) {
    const gl = this.gl;
    const scale = (window.devicePixelRatio || 1) * 4;
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
      const padX = 12, padY = 8;
      const fontSize = item.fontSize || 24;
      const fontFamily = item.fontFamily || "'DM Sans', sans-serif";

      ctx.font = `${item.italic ? 'italic' : 'normal'} ${item.bold ? 'bold' : 'normal'} ${fontSize}px ${fontFamily}`;
      ctx.fillStyle = 'white';
      ctx.textBaseline = 'top';
      ctx.textAlign = item.align || 'left';

      const maxWidth = item.w - padX * 2;
      const lines = this._wrapText(ctx, item.text, maxWidth);
      const lineHeight = fontSize * 1.3;

      let x;
      if (item.align === 'center') x = item.w / 2;
      else if (item.align === 'right') x = item.w - padX;
      else x = padX;

      // Link items vertically center their text
      let startY = padY;
      if (item.type === 'link') {
        startY = (item.h - lines.length * lineHeight) / 2;
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

  _wrapText(ctx, text, maxWidth) {
    const lines = [];
    // Handle explicit newlines (pre-wrap)
    const paragraphs = text.split('\n');
    for (const para of paragraphs) {
      if (!para) { lines.push(''); continue; }
      const words = para.split(/(\s+)/);
      let currentLine = '';
      for (const word of words) {
        const test = currentLine + word;
        if (ctx.measureText(test).width > maxWidth && currentLine) {
          lines.push(currentLine);
          currentLine = word.trimStart();
        } else {
          currentLine = test;
        }
      }
      if (currentLine) lines.push(currentLine);
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
  }

  destroy() {
    for (const entry of this.cache.values()) {
      this.gl.deleteTexture(entry.tex);
    }
    this.cache.clear();
    this.itemKeys.clear();
  }
}
