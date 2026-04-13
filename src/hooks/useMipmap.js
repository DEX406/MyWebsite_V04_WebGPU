import { useEffect, useRef, useCallback, useState } from 'react';
import { generateMipmaps } from '../api.js';
import { isGifSrc, isSvgSrc } from '../utils.js';

// Track in-flight mipmap generation requests globally to avoid duplicates
const pendingGenerations = new Set();

/**
 * Manages mipmap tier selection for all image items on the canvas.
 *
 * Sets two ephemeral properties on each image item:
 *   - placeholderSrc: always the lowest available variant (loaded first, cheap)
 *   - targetSrc: the DPI-appropriate variant for crisp rendering
 *
 * Key behaviours:
 *   - MIP assessment ONLY runs when zoom/pan settles (not during active zoom)
 *   - Off-screen items keep their current targetSrc (highest res already loaded)
 *     so GPU memory retains that texture for fast redraw when scrolling back
 *   - Only upgrades targetSrc to higher quality, never downgrades
 */
export function useMipmap(items, updateItem, vp) {
  const [settled, setSettled] = useState(0); // increments on each settle
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Wire up the settled callback from useViewport
  useEffect(() => {
    vp.onSettledRef.current = () => setSettled(c => c + 1);
    return () => { vp.onSettledRef.current = null; };
  }, [vp.onSettledRef]);

  // Trigger mipmap generation for images missing variants
  useEffect(() => {
    const images = items.filter(i =>
      i.type === 'image' &&
      i.src &&
      !i.srcQ50 &&
      !i._mipmapPending &&
      !pendingGenerations.has(i.src)
    );

    // Skip GIFs (animated, rendered via DOM overlay) and SVGs (vector, no raster mipmaps)
    const eligible = images.filter(i => !isGifSrc(i.src) && !isSvgSrc(i.src));

    // Only process R2-hosted images
    const r2Images = eligible.filter(i => i.src.includes('r2.dev'));

    for (const item of r2Images) {
      pendingGenerations.add(item.src);
      generateMipmaps(item.src).then(result => {
        pendingGenerations.delete(item.src);
        if (result && (result.srcQ50 || result.srcQ25 || result.srcQ12 || result.srcQ6)) {
          updateItem(item.id, {
            srcQ50: result.srcQ50 || null,
            srcQ25: result.srcQ25 || null,
            srcQ12: result.srcQ12 || null,
            srcQ6: result.srcQ6 || null,
          });
        }
      }).catch(() => {
        pendingGenerations.delete(item.src);
      });
    }
  }, [items, updateItem]);

  // Compute display sources for all image items whenever viewport settles
  const computeDisplaySources = useCallback(() => {
    const bounds = vp.getViewportBounds();
    const zoom = vp.zoomRef.current;

    for (const item of itemsRef.current) {
      if (item.type !== 'image' || !item.src) continue;
      if (!item.srcQ50 && !item.srcQ25 && !item.srcQ12 && !item.srcQ6) continue; // no variants available

      const isOnscreen = itemIsOnscreen(item, bounds);
      const needed = pickTier(item, zoom, isOnscreen);
      const placeholder = lowestTier(item);

      // Never downgrade: if the item already has a higher-res targetSrc loaded,
      // keep it. This preserves GPU memory for fast redraw when scrolling back.
      const target = higherTier(item, needed, item.targetSrc);

      const updates = {};
      if (target !== item.targetSrc) updates.targetSrc = target;
      if (placeholder !== item.placeholderSrc) updates.placeholderSrc = placeholder;
      // Keep displaySrc pointing at target for MipmapImage (DOM) compatibility
      if (target !== item.displaySrc) updates.displaySrc = target;

      if (Object.keys(updates).length > 0) {
        updateItem(item.id, updates);
      }
    }
  }, [vp, updateItem]);

  // Re-evaluate on every settle event (zoom/pan has stopped)
  useEffect(() => {
    if (settled > 0) computeDisplaySources();
  }, [settled, computeDisplaySources]);

  // Also evaluate once when mipmaps become available
  const prevMipmapCountRef = useRef(0);
  useEffect(() => {
    const count = items.filter(i => i.srcQ50 || i.srcQ25 || i.srcQ12 || i.srcQ6).length;
    if (count > prevMipmapCountRef.current) {
      computeDisplaySources();
    }
    prevMipmapCountRef.current = count;
  }, [items, computeDisplaySources]);
}

function itemIsOnscreen(item, bounds) {
  // AABB intersection test
  const itemRight = item.x + item.w;
  const itemBottom = item.y + item.h;
  return !(item.x > bounds.right || itemRight < bounds.left ||
           item.y > bounds.bottom || itemBottom < bounds.top);
}

// Returns the lowest available variant (for use as placeholder)
function lowestTier(item) {
  return item.srcQ6 || item.srcQ12 || item.srcQ25 || item.srcQ50 || item.src;
}

// Tier ordering from lowest quality to highest
const TIER_KEYS = ['srcQ6', 'srcQ12', 'srcQ25', 'srcQ50', 'src'];

function tierIndex(item, url) {
  if (!url) return -1;
  for (let i = 0; i < TIER_KEYS.length; i++) {
    const key = TIER_KEYS[i];
    if (key === 'src' ? item.src === url : item[key] === url) return i;
  }
  return -1;
}

/**
 * Returns whichever of `a` or `b` is the higher-quality tier for the given item.
 * If either is null/undefined, returns the other.
 */
function higherTier(item, a, b) {
  if (!b) return a;
  if (!a) return b;
  const ai = tierIndex(item, a);
  const bi = tierIndex(item, b);
  return ai >= bi ? a : b;
}

function pickTier(item, zoom, isOnscreen) {
  // Off-screen: request the lowest tier (but higherTier() in the caller
  // will prevent actual downgrade if a better version is already loaded)
  if (!isOnscreen) {
    return lowestTier(item);
  }

  // On-screen: DPI-aware selection
  const natW = item.naturalWidth || item.w;
  const natH = item.naturalHeight || item.h;
  const coverScale = Math.max(item.w / natW, item.h / natH);
  const dpr = window.devicePixelRatio || 1;
  const renderedSize = Math.max(natW, natH) * coverScale * zoom * dpr;

  const natSize = Math.max(natW, natH);

  const q6Size = natSize * 0.0625;
  const q12Size = natSize * 0.125;
  const q25Size = natSize * 0.25;
  const q50Size = natSize * 0.50;

  if (item.srcQ6 && q6Size >= renderedSize) return item.srcQ6;
  if (item.srcQ12 && q12Size >= renderedSize) return item.srcQ12;
  if (item.srcQ25 && q25Size >= renderedSize) return item.srcQ25;
  if (item.srcQ50 && q50Size >= renderedSize) return item.srcQ50;
  return item.src;
}
