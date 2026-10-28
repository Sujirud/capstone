/**
 * A single choice from a longer list, as the platform's own select: one
 * row with a visible label, the phone's native picker, and the keyboard's. Styled like the
 * text field: a `--line-strong` border, 4 px corners, at least 48 px tall.
 */
import { ChevronDown } from "lucide-react";
import { useId } from "react";
import { cx } from "./cx";
import { ICON } from "./icon";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

export function Select<T extends string>({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: T;
  onChange(value: T): void;
  options: ReadonlyArray<SelectOption<T>>;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="block font-medium">
        {label}
      </label>
      <div className="relative mt-2 max-w-field">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value as T)}
          className="block min-h-12 w-full appearance-none rounded-control border border-line-strong bg-surface pr-12 pl-3 text-base text-ink"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown {...ICON} size={20} aria-hidden="true" className={cx("pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-ink-2")} />
      </div>
    </div>
  );
}
