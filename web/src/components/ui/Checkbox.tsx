/**
 * An on/off option: the platform's own checkbox in the accent, with its
 * visible label, and the whole row at least 44 px tall.
 */
import { useId, type ReactNode } from "react";
import { cx } from "./cx";

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
  description,
  className,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  /** Shown under the label and linked to the checkbox. */
  description?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className={cx("inline-flex min-h-target items-center gap-3", disabled && "text-ink-3")}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={description ? `${id}-description` : undefined}
          className="size-6 shrink-0 accent-accent"
        />
        {label}
      </label>
      {description && (
        <p id={`${id}-description`} className="text-sm text-ink-2">
          {description}
        </p>
      )}
    </div>
  );
}
