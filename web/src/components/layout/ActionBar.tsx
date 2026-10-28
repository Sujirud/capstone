/**
 * The sticky bottom action bar: the screen's one primary action, above
 * the home indicator (safe-area inset), with a top hairline instead of a shadow. Its
 * height feeds scroll-padding so focused controls are never hidden behind it (2.4.11).
 */
import { useEffect, useRef, type ReactNode } from "react";

export function ActionBar({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty("--action-bar-height", `${el.offsetHeight}px`);
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--action-bar-height");
    };
  }, []);
  return (
    <div ref={ref} className="sticky bottom-0 z-10 border-t border-line bg-paper print:hidden">
      <div className={`mx-auto flex w-full ${wide ? "max-w-wide" : "max-w-page"} flex-col-reverse gap-2 px-4 pt-3 pb-[calc(var(--space-3)+env(safe-area-inset-bottom))] md:flex-row md:justify-end`}>
        {children}
      </div>
    </div>
  );
}
