// WebGPU texture cache: loads images from URLs into GPUTextures, manages video textures.
// Supports FIFO eviction with placeholder protection — low-res placeholders are evicted last.

const MAX_TEXTURES = 200;

export class TextureCache {
  constructor(device, onTextureReady) {
    this.device = device;
    this.cache = new Map(); // url → { tex, view, width, height, ready, isPlaceholder, insertOrder }
    this.videos = new Map(); // itemId → { video, tex, view, src, width, height, ready }
    this.gifs = new Map();   // url → { img, tex, view, src, width, height, ready }
    this.loading = new Set();
    this.insertCounter = 0;
    this._onTextureReady = onTextureReady || null;

    // Hidden container for GIF <img> elements — must be in the DOM so
    // browsers keep advancing animation frames.
    this._gifContainer = document.createElement('div');
    this._gifContainer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none;opacity:0;z-index:-1';
    document.body.appendChild(this._gifContainer);

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
    return { tex, view: tex.createView(), width: 1, height: 1, ready: true };
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

  _evict() {
    if (this.cache.size <= MAX_TEXTURES) return;
    const entries = [...this.cache.entries()]
      .map(([url, entry]) => ({ url, ...entry }))
      .sort((a, b) => a.insertOrder - b.insertOrder);
    const nonPlaceholders = entries.filter(e => !e.isPlaceholder);
    const placeholders = entries.filter(e => e.isPlaceholder);
    const evictOrder = [...nonPlaceholders, ...placeholders];
    const toEvict = this.cache.size - MAX_TEXTURES;
    for (let i = 0; i < toEvict && i < evictOrder.length; i++) {
      const e = evictOrder[i];
      e.tex.destroy();
      this.cache.delete(e.url);
    }
  }

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
        const tex = this._createFromSource(img, img.naturalWidth, img.naturalHeight);
        const entry = {
          tex,
          view: tex.createView(),
          width: img.naturalWidth,
          height: img.naturalHeight,
          ready: true,
          isPlaceholder,
          insertOrder: this.insertCounter++,
        };
        this.cache.set(url, entry);
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

  getVideo(itemId, src) {
    let entry = this.videos.get(itemId);
    if (entry && entry.src === src) {
      if (entry.video.readyState >= 2) {
        // Re-create texture each frame from video (copyExternalImageToTexture requires matching size)
        const vw = entry.video.videoWidth;
        const vh = entry.video.videoHeight;
        if (vw > 0 && vh > 0) {
          // Reuse texture if same size, otherwise recreate
          if (entry.width !== vw || entry.height !== vh) {
            entry.tex.destroy();
            entry.tex = this._createFromSource(entry.video, vw, vh);
            entry.view = entry.tex.createView();
          } else {
            this.device.queue.copyExternalImageToTexture(
              { source: entry.video, flipY: false },
              { texture: entry.tex },
              [vw, vh],
            );
          }
          entry.ready = true;
          entry.width = vw;
          entry.height = vh;
        }
      }
      return entry;
    }

    // Clean up old video
    if (entry) {
      entry.video.pause();
      entry.video.src = '';
      entry.tex.destroy();
    }

    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.src = src;
    video.play().catch(() => {});

    // Start with 1x1 black placeholder
    const tex1 = this._create1x1([0, 0, 0, 255]);
    const newEntry = {
      video,
      tex: tex1.tex,
      view: tex1.view,
      src,
      width: 1,
      height: 1,
      ready: false,
    };
    this.videos.set(itemId, newEntry);
    return newEntry;
  }

  pruneVideos(activeIds) {
    const activeSet = new Set(activeIds);
    for (const [id, entry] of this.videos) {
      if (!activeSet.has(id)) {
        entry.video.pause();
        entry.video.src = '';
        entry.tex.destroy();
        this.videos.delete(id);
      }
    }
  }

  // ── Animated GIF support ──────────────────────────────────────────────────
  // Keeps a live <img> element per GIF URL. The browser's native decoder
  // advances frames; we copy the current frame to a GPUTexture each render.
  // This is the most efficient path — the decode runs in optimised C++ and
  // copyExternalImageToTexture is a fast GPU memory copy.

  getGif(src) {
    let entry = this.gifs.get(src);
    if (entry) {
      if (entry.ready && entry.img.complete) {
        const iw = entry.img.naturalWidth;
        const ih = entry.img.naturalHeight;
        if (iw > 0 && ih > 0) {
          if (entry.width !== iw || entry.height !== ih) {
            entry.tex.destroy();
            entry.tex = this._createFromSource(entry.img, iw, ih);
            entry.view = entry.tex.createView();
            entry.width = iw;
            entry.height = ih;
          } else {
            this.device.queue.copyExternalImageToTexture(
              { source: entry.img, flipY: false },
              { texture: entry.tex },
              [iw, ih],
            );
          }
        }
      }
      return entry;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    // Must be in the DOM for the browser to keep advancing GIF frames
    this._gifContainer.appendChild(img);

    const tex1 = this._create1x1([0, 0, 0, 0]);
    const newEntry = {
      img,
      tex: tex1.tex,
      view: tex1.view,
      src,
      width: 1,
      height: 1,
      ready: false,
    };

    img.onload = () => {
      newEntry.ready = true;
      if (this._onTextureReady) this._onTextureReady();
    };
    img.onerror = () => {};
    img.src = src;

    this.gifs.set(src, newEntry);
    return newEntry;
  }

  pruneGifs(activeSrcs) {
    const activeSet = new Set(activeSrcs);
    for (const [src, entry] of this.gifs) {
      if (!activeSet.has(src)) {
        entry.img.remove();
        entry.img.src = '';
        entry.tex.destroy();
        this.gifs.delete(src);
      }
    }
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
    for (const entry of this.videos.values()) {
      entry.video.pause();
      entry.video.src = '';
      entry.tex.destroy();
    }
    for (const entry of this.gifs.values()) {
      entry.img.remove();
      entry.img.src = '';
      entry.tex.destroy();
    }
    this.fallback.tex.destroy();
    this.transparent.tex.destroy();
    this.cache.clear();
    this.videos.clear();
    this.gifs.clear();
    this._gifContainer.remove();
  }
}
