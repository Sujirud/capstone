/**
 * Zoom and pan inside a photo surface: pinch, double-tap (optional),
 * Ctrl/⌘ + wheel (trackpad pinch), one-finger pan when zoomed, and buttons for keyboard
 * and single-pointer use. Page zoom stays enabled: only the surface handles gestures, and
 * at 1× a vertical swipe still scrolls the page (`touch-action: pan-y`).
 *
 * The content (image and SVG layer) fills the surface at 1× and is transformed with
 * `translate(x, y) scale(s)` from its top-left corner.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

export interface View {
  scale: number;
  x: number;
  y: number;
}

export const IDENTITY: View = { scale: 1, x: 0, y: 0 };
export const DOUBLE_TAP_SCALE = 2.5;
const TAP_SLOP_PX = 8;
const TAP_MS = 350;

export interface Size {
  width: number;
  height: number;
}

/** Keep the content covering the surface. */
export function clampView(v: View, size: Size, maxScale: number): View {
  const scale = Math.min(maxScale, Math.max(1, v.scale));
  const minX = size.width - size.width * scale;
  const minY = size.height - size.height * scale;
  return { scale, x: Math.min(0, Math.max(minX, v.x)), y: Math.min(0, Math.max(minY, v.y)) };
}

/** Zoom to `scale` keeping the surface point (fx, fy) fixed. */
export function zoomAt(v: View, scale: number, fx: number, fy: number, size: Size, maxScale: number): View {
  const s = Math.min(maxScale, Math.max(1, scale));
  const u = (fx - v.x) / v.scale;
  const w = (fy - v.y) / v.scale;
  return clampView({ scale: s, x: fx - u * s, y: fy - w * s }, size, maxScale);
}

/** A view showing the surface-space rectangle `r` as large as fits (for framing a face). */
export function frame(r: { x: number; y: number; width: number; height: number }, size: Size, maxScale: number): View {
  if (!(r.width > 0 && r.height > 0 && size.width > 0 && size.height > 0)) return IDENTITY; // not laid out yet
  const scale = Math.min(maxScale, Math.max(1, Math.min(size.width / r.width, size.height / r.height)));
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  return clampView({ scale, x: size.width / 2 - cx * scale, y: size.height / 2 - cy * scale }, size, maxScale);
}

export interface ZoomPanOptions {
  maxScale?: number;
  doubleTapZoom?: boolean;
  /** A tap that did not move: surface coordinates of the content (unscaled). */
  onTap?: (point: { x: number; y: number }) => void;
}

interface Pointer {
  x: number;
  y: number;
  startX: number;
  startY: number;
  t: number;
}

export function useZoomPan({ maxScale = 6, doubleTapZoom = false, onTap }: ZoomPanOptions = {}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(IDENTITY);
  const [surfaceSize, setSurfaceSize] = useState<Size>({ width: 0, height: 0 });
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const pointers = useRef(new Map<number, Pointer>());
  const lastTap = useRef<{ x: number; y: number; t: number } | null>(null);
  const pinch = useRef<{ distance: number; midX: number; midY: number } | null>(null);

  const size = useCallback((): Size => {
    const el = surfaceRef.current;
    return el ? { width: el.clientWidth, height: el.clientHeight } : { width: 1, height: 1 };
  }, []);

  // The surface's size for rendering (points and the loupe are placed in surface pixels).
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const update = () => setSurfaceSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const local = useCallback((clientX: number, clientY: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return rect ? { x: clientX - rect.left, y: clientY - rect.top } : { x: clientX, y: clientY };
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const p = local(e.clientX, e.clientY);
      pointers.current.set(e.pointerId, { ...p, startX: p.x, startY: p.y, t: e.timeStamp });
      e.currentTarget.setPointerCapture?.(e.pointerId);
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()] as [Pointer, Pointer];
        pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
      }
    },
    [local],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const prev = pointers.current.get(e.pointerId);
      if (!prev) return;
      const p = local(e.clientX, e.clientY);
      pointers.current.set(e.pointerId, { ...prev, x: p.x, y: p.y });
      if (pointers.current.size >= 2 && pinch.current) {
        const [a, b] = [...pointers.current.values()] as [Pointer, Pointer];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const last = pinch.current;
        pinch.current = { distance, midX, midY };
        setView((v) => {
          const zoomed = zoomAt(v, v.scale * (distance / Math.max(1, last.distance)), last.midX, last.midY, size(), maxScale);
          return clampView({ ...zoomed, x: zoomed.x + midX - last.midX, y: zoomed.y + midY - last.midY }, size(), maxScale);
        });
      } else if (pointers.current.size === 1) {
        setView((v) => (v.scale > 1 ? clampView({ ...v, x: v.x + p.x - prev.x, y: v.y + p.y - prev.y }, size(), maxScale) : v));
      }
    },
    [local, maxScale, size],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const p = pointers.current.get(e.pointerId);
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) pinch.current = null;
      if (!p || e.type === "pointercancel") return;
      const moved = Math.hypot(p.x - p.startX, p.y - p.startY);
      if (moved > TAP_SLOP_PX || e.timeStamp - p.t > TAP_MS || pointers.current.size > 0) return;
      const prevTap = lastTap.current;
      if (doubleTapZoom && prevTap && e.timeStamp - prevTap.t < TAP_MS && Math.hypot(p.x - prevTap.x, p.y - prevTap.y) < 30) {
        lastTap.current = null;
        setView((v) => (v.scale > 1 ? IDENTITY : zoomAt(v, DOUBLE_TAP_SCALE, p.x, p.y, size(), maxScale)));
        return;
      }
      lastTap.current = { x: p.x, y: p.y, t: e.timeStamp };
      const v = viewRef.current;
      onTap?.({ x: (p.x - v.x) / v.scale, y: (p.y - v.y) / v.scale });
    },
    [doubleTapZoom, maxScale, onTap, size],
  );

  // Ctrl/⌘ + wheel (a trackpad pinch) zooms the photo instead of the page. React's wheel
  // listeners are passive, so this one is native to be able to prevent the page zoom.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // a plain wheel scrolls the page
      e.preventDefault();
      const p = local(e.clientX, e.clientY);
      setView((v) => zoomAt(v, v.scale * Math.exp(-e.deltaY / 200), p.x, p.y, size(), maxScale));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [local, maxScale, size]);

  const zoomBy = useCallback(
    (factor: number) => {
      const s = size();
      setView((v) => zoomAt(v, v.scale * factor, s.width / 2, s.height / 2, s, maxScale));
    },
    [maxScale, size],
  );

  const contentStyle: CSSProperties = {
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
    transformOrigin: "0 0",
  };
  const surfaceStyle: CSSProperties = { touchAction: view.scale > 1 ? "none" : "pan-y" };

  return {
    surfaceRef,
    view,
    surfaceSize,
    setView: (v: View) => setView(clampView(v, size(), maxScale)),
    size,
    contentStyle,
    surfaceStyle,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
    zoomIn: () => zoomBy(1.6),
    zoomOut: () => zoomBy(1 / 1.6),
    reset: () => setView(IDENTITY),
    maxScale,
  };
}
