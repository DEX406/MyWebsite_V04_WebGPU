// Math-based hit testing for WebGPU renderer.

export function hitTest(screenX, screenY, items, panX, panY, zoom) {
  const worldX = (screenX - panX) / zoom;
  const worldY = (screenY - panY) / zoom;

  const sorted = [...items].sort((a, b) => b.z - a.z);

  for (const item of sorted) {
    if (item.type === 'connector') {
      if (hitConnector(worldX, worldY, item)) return { id: item.id, action: null };
    } else if (hitRect(worldX, worldY, item)) {
      return { id: item.id, action: null };
    }
  }

  return null;
}

function hitRect(wx, wy, item) {
  const cx = item.x + item.w / 2;
  const cy = item.y + item.h / 2;
  const rad = -(item.rotation || 0) * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const dx = wx - cx;
  const dy = wy - cy;
  const localX = dx * cos - dy * sin + item.w / 2;
  const localY = dx * sin + dy * cos + item.h / 2;

  return localX >= 0 && localX <= item.w && localY >= 0 && localY <= item.h;
}

function hitConnector(wx, wy, item) {
  const { x1, y1, x2, y2, lineWidth = 2 } = item;
  const elbowX = item.elbowX ?? (x1 + x2) / 2;
  const elbowY = item.elbowY ?? (y1 + y2) / 2;
  const orient = item.orientation || 'h';
  const threshold = Math.max(8, lineWidth + 6);

  let segments;
  if (orient === 'h') {
    segments = [[x1, y1, elbowX, y1], [elbowX, y1, elbowX, y2], [elbowX, y2, x2, y2]];
  } else {
    segments = [[x1, y1, x1, elbowY], [x1, elbowY, x2, elbowY], [x2, elbowY, x2, y2]];
  }

  for (const [sx, sy, ex, ey] of segments) {
    if (distToSegment(wx, wy, sx, sy, ex, ey) < threshold) return true;
  }

  const dotR = item.dotRadius || 5;
  if (Math.hypot(wx - x1, wy - y1) < dotR + 4) return true;
  if (Math.hypot(wx - x2, wy - y2) < dotR + 4) return true;

  return false;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
