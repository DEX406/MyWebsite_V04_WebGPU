// WebGPU texture cache: loads static images from URLs into GPUTextures.
// Tracks GPU memory in bytes with adjustable limits.
// Eviction order: placeholders first (smallest), then FIFO — but never evict on-screen textures.

const BYTES_PER_PIXEL = 4; // RGBA8

// Default 512 MB limit — adjustable at runtime via setMemoryLimit()
let memoryLimitBytes = 512 * 1024 * 1024;

export class TextureCache {
  constructor(device, onTextureReady) {
    this.device = device;
    // url → { tex, view, width, height, ready, isPlaceholder, insertOrder, byteSize }
    this.cache = new Map();
    this.loading = new Set();
    this.insertCounter = 0;
    this._onTextureReady = onTextureReady || null;

    // Byte-based memory tracking
    this.memoryUsedBytes = 0;

    // Set of URLs currently visible on screen — updated each frame by the renderer
    this._onScreenUrls = new Set();

    // Samplers (shared across all textures)
    this.nearestSampler = device.createSampler({
      minFilter: 'nearest',
      magFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.linearSampler = device.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // 1x1 fallback textures
    this.fallback = this._create1x1([0, 0, 0, 0]);
    this.transparent = this._create1x1([0, 0, 0, 0]);
  }

  // ── Memory limit API ────────────────────────────────────────────────────────

  static getMemoryLimit() { return memoryLimitBytes; }
  static setMemoryLimit(bytes) { memoryLimitBytes = Math.max(64 * 1024 * 1024, bytes); }

  getMemoryUsed() { return this.memoryUsedBytes; }
  getMemoryLimit() { return memoryLimitBytes; }

  /** Mark which URLs are currently visible so eviction can protect them. */
  setOnScreenUrls(urls) {
    this._onScreenUrls = urls;
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  _texBytes(w, h) {
    return w * h * BYTES_PER_PIXEL;
  }

  _create1x1(rgba) {
    const tex = this.device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: tex },
      new Uint8Array(rgba),
      { bytesPerRow: 4 },
      [1, 1],
    );
    return { tex, view: tex.createView(), width: 1, height: 1, ready: true, byteSize: 4 };
  }

  _createFromSource(source, w, h) {
    const tex = this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source, flipY: false },
      { texture: tex },
      [w, h],
    );
    return tex;
  }

  isReady(url) {
    if (!url) return false;
    const entry = this.cache.get(url);
    return !!(entry && entry.ready);
  }

  // ── Eviction ──────────────────────────────────────────────────────────────

  _evict() {
    if (this.memoryUsedBytes <= memoryLimitBytes) return;

    const entries = [...this.cache.entries()]
      .map(([url, entry]) => ({ url, ...entry }));

    // Separate into buckets: on-screen (protected), placeholders, non-placeholders
    const onScreen = [];
    const placeholders = [];
    const nonPlaceholders = [];

    for (const e of entries) {
      if (this._onScreenUrls.has(e.url)) {
        onScreen.push(e); // never evict
      } else if (e.isPlaceholder) {
        placeholders.push(e);
      } else {
        nonPlaceholders.push(e);
      }
    }

    // Eviction order: placeholders first (smallest/cheapest), then non-placeholders FIFO
    // Within each group, sort by insertOrder (oldest first = FIFO)
    placeholders.sort((a, b) => a.insertOrder - b.insertOrder);
    nonPlaceholders.sort((a, b) => a.insertOrder - b.insertOrder);
    const evictOrder = [...placeholders, ...nonPlaceholders];

    for (let i = 0; i < evictOrder.length && this.memoryUsedBytes > memoryLimitBytes; i++) {
      const e = evictOrder[i];
      this.memoryUsedBytes -= e.byteSize;
      e.tex.destroy();
      this.cache.delete(e.url);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get(url, pixelated = false, isPlaceholder = false) {
    if (!url) return this.transparent;
    const cached = this.cache.get(url);
    if (cached) return cached;

    if (!this.loading.has(url)) {
      this.loading.add(url);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this.loading.delete(url);
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const byteSize = this._texBytes(w, h);
        const tex = this._createFromSource(img, w, h);
        const entry = {
          tex,
          view: tex.createView(),
          width: w,
          height: h,
          ready: true,
          isPlaceholder,
          insertOrder: this.insertCounter++,
          byteSize,
        };
        this.cache.set(url, entry);
        this.memoryUsedBytes += byteSize;
        this._evict();
        if (this._onTextureReady) this._onTextureReady();
      };
      img.onerror = () => { this.loading.delete(url); };
      img.src = url;
    }

    return this.fallback;
  }

  getBestReady(candidates, pixelated = false) {
    let bestEntry = null;
    let bestUrl = null;
    for (let i = 0; i < candidates.length; i++) {
      const url = candidates[i];
      if (!url) continue;
      const isFirst = i === 0;
      const isLast = i === candidates.length - 1;
      if (isFirst || isLast) {
        const entry = this.get(url, pixelated, isLast);
        if (!bestEntry && entry.ready && entry !== this.fallback && entry !== this.transparent) {
          bestEntry = entry;
          bestUrl = url;
        }
      } else {
        const cached = this.cache.get(url);
        if (!bestEntry && cached && cached.ready) {
          bestEntry = cached;
          bestUrl = url;
        }
      }
    }
    return bestEntry ? { entry: bestEntry, url: bestUrl } : { entry: this.fallback, url: null };
  }

  // Compute UV crop rect for object-fit: cover (pure math — no GPU calls)
  coverUV(texW, texH, itemW, itemH) {
    if (!texW || !texH || !itemW || !itemH) return [0, 0, 1, 1];
    const texAspect = texW / texH;
    const itemAspect = itemW / itemH;
    if (texAspect > itemAspect) {
      const scale = itemAspect / texAspect;
      const offset = (1 - scale) / 2;
      return [offset, 0, scale, 1];
    } else {
      const scale = texAspect / itemAspect;
      const offset = (1 - scale) / 2;
      return [0, offset, 1, scale];
    }
  }

  destroy() {
    for (const entry of this.cache.values()) entry.tex.destroy();
    this.fallback.tex.destroy();
    this.transparent.tex.destroy();
    this.cache.clear();
    this.memoryUsedBytes = 0;
  }
}
