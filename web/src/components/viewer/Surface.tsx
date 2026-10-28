/**
 * The photo surface shared by the viewer and the adjustment view: the --viewer surround,
 * the image's aspect ratio, and a height cap so the whole photo fits on screen.
 */
import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../ui/cx";

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  width: number;
  height: number;
  /** Largest share of the viewport height the photo may use. */
  maxViewportHeight?: number;
  children: ReactNode;
}

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { width, height, maxViewportHeight = 0.7, className, style, children, ...rest },
  ref,
) {
  const sizing: CSSProperties = {
    aspectRatio: `${width} / ${height}`,
    width: `min(100%, calc(${maxViewportHeight * 100}dvh * ${width} / ${height}))`,
    ...style,
  };
  return (
    <div ref={ref} className={cx("relative mx-auto overflow-hidden rounded-viewer bg-viewer select-none", className)} style={sizing} {...rest}>
      {children}
    </div>
  );
});
