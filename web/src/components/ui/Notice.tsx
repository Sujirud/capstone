/**
 * Notices: a 3 px left rule in --ink-2 on --notice, with an optional info
 * glyph. Calm, never alarming; used for the core's warnings and notes as well.
 */
import { Info } from "lucide-react";
import { ICON } from "./icon";
import type { ReactNode } from "react";
import { cx } from "./cx";

export interface NoticeProps {
  children: ReactNode;
  icon?: boolean;
  /** `status` for polite announcements, `alert` for errors. */
  role?: "status" | "alert";
  className?: string;
  lang?: string;
  "data-warning"?: string;
  "data-testid"?: string;
}

export function Notice({ children, icon = true, role, className, lang, "data-warning": warning, "data-testid": testId }: NoticeProps) {
  return (
    <div
      role={role}
      lang={lang}
      data-warning={warning}
      data-testid={testId}
      className={cx("flex gap-3 border-l-[length:var(--rule)] border-ink-2 bg-notice px-4 py-3", className)}
    >
      {icon && <Info {...ICON} size={20} className="mt-1 shrink-0 text-ink-2" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
