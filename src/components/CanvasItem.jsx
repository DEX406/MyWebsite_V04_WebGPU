import { useState, useEffect } from 'react';
import { ConnectorHandles } from './ConnectorHandles.jsx';
import { ItemHandles } from './ItemHandles.jsx';
import { Z } from '../styles.js';
import { TEXT_PAD_X, TEXT_PAD_Y, TEXT_LINE_HEIGHT, TEXT_DEFAULT_SIZE, FONT } from '../constants.js';

function useNaturalSize(src) {
  const [size, setSize] = useState(null);
  useEffect(() => {
    if (!src) return;
    let alive = true;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { if (alive) setSize({ w: img.naturalWidth, h: img.naturalHeight }); };
    img.src = src;
    return () => { alive = false; };
  }, [src]);
  return size;
}

function imgFormat(src) {
  if (!src) return null;
  if (src.startsWith('data:image/')) {
    const m = src.match(/^data:image\/(\w+)/);
    return m ? m[1].toUpperCase() : null;
  }
  const ext = src.split('?')[0].split('#')[0].split('.').pop().toLowerCase();
  return { jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG', gif: 'GIF', webp: 'WebP', avif: 'AVIF', svg: 'SVG', bmp: 'BMP', webm: 'WEBM', mp4: 'MP4', mov: 'MOV' }[ext] || null;
}

function imgSrcType(src) {
  if (!src) return null;
  if (src.startsWith('http') && !src.includes('r2.dev')) return 'link';
  return 'stored';
}

function ImageInfoPill({ src, item }) {
  const imgSize = useNaturalSize(item?.type === "video" ? null : src);
  const size = item?.type === "video"
    ? (item.naturalWidth ? { w: item.naturalWidth, h: item.naturalHeight } : null)
    : imgSize;
  const format = imgFormat(src);
  const srcType = imgSrcType(src);
  if (!size) return null;
  const parts = [format, srcType, `${size.w} × ${size.h}`].filter(Boolean);
  return (
    <div style={{
      position: "absolute", top: "calc(100% + 8px)", left: "50%",
      transform: "translateX(-50%)", pointerEvents: "none", whiteSpace: "nowrap",
      background: "rgba(20,20,19,0.85)", backdropFilter: "blur(16px)",
      border: "1px solid rgba(194,192,182,0.09)", borderRadius: 20,
      padding: "3px 10px", display: "flex", alignItems: "center", gap: 6,
      fontSize: 10, fontFamily: "inherit", color: "rgba(194,192,182,0.55)",
      letterSpacing: "0.04em",
    }}>
      {parts.map((p, i) => (
        <span key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {i > 0 && <span style={{ opacity: 0.3 }}>·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}


export function CanvasItem({ item, selectedIds, isAdmin, editingTextId, deleteItems, updateItem, setEditingTextId }) {
  const isSel = selectedIds.includes(item.id) && isAdmin;

  if (!isSel) return null;

  // Connector type — delegate to specialized handle component
  if (item.type === "connector") {
    return <ConnectorHandles item={item} deleteItems={deleteItems} />;
  }

  // Render handles for non-connector items
  const isEd = editingTextId === item.id && (item.type === "text" || item.type === "link");
  const fs = item.fontSize || TEXT_DEFAULT_SIZE;

  return (
    <>
      {isEd && (
        <textarea data-ui autoFocus value={item.text}
          onFocus={() => { if (item.placeholder) updateItem(item.id, { text: "", placeholder: false }); }}
          onChange={e => updateItem(item.id, { text: e.target.value })}
          onBlur={() => setEditingTextId(null)}
          onPointerDown={e => e.stopPropagation()}
          onTouchStart={e => e.stopPropagation()}
          style={{
            position: "absolute", left: item.x, top: item.y, width: item.w, height: item.h,
            transform: `rotate(${item.rotation || 0}deg)`, transformOrigin: "center center",
            resize: "none", border: "none", outline: "none",
            overflow: "hidden", whiteSpace: "pre-wrap", wordBreak: "break-word",
            pointerEvents: "auto", touchAction: "auto",
            lineHeight: `${fs * TEXT_LINE_HEIGHT}px`,
            padding: `${TEXT_PAD_Y}px ${TEXT_PAD_X}px`, boxSizing: "border-box",
            WebkitAppearance: "none", appearance: "none",
            background: "transparent",
            color: item.color, WebkitTextFillColor: item.color,
            fontSize: fs, fontFamily: item.fontFamily || FONT,
            fontWeight: item.bold ? "bold" : "normal", fontStyle: item.italic ? "italic" : "normal",
            textAlign: item.align || "left",
            zIndex: Z.HANDLE_INFO,
          }} />
      )}
      <ItemHandles item={item} deleteItems={deleteItems} />
      {(item.type === "image" || item.type === "video") && (
        <div style={{ position: "absolute", left: item.x, top: item.y, width: item.w, height: item.h, zIndex: Z.HANDLE_INFO, pointerEvents: "none" }}>
          <ImageInfoPill src={item.src} item={item} />
        </div>
      )}
    </>
  );
}
