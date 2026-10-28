/**
 * The thin progress line: determinate for uploads (real percent), or
 * indeterminate while the service analyzes. It is the only looping animation, and it is
 * hidden with reduced motion, where the status text alone remains. Decorative: the
 * status text next to it carries the information.
 */
import { cx } from "./cx";

export function ProgressLine({ value, className }: { value: number | null; className?: string }) {
  return (
    <div aria-hidden="true" className={cx("relative h-[3px] w-full overflow-hidden bg-line motion-reduce:hidden", className)}>
      {value === null ? (
        <div className="absolute inset-y-0 left-0 w-2/5 animate-indeterminate bg-accent" />
      ) : (
        <div className="h-full bg-accent" style={{ width: `${Math.min(1, Math.max(0, value)) * 100}%` }} />
      )}
    </div>
  );
}
