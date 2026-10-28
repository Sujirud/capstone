/**
 * A two-option switch, e.g. "with measurement lines" / "original" in the
 * photo viewer. Radix ToggleGroup (single): arrow keys move between the options. The
 * selected option is marked by the accent, weight and a border, not colour alone.
 */
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { cx } from "./cx";

export interface SegmentedControlProps<T extends string> {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

export function SegmentedControl<T extends string>({ label, options, value, onChange, className }: SegmentedControlProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      aria-label={label}
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      className={cx("inline-flex rounded-control border border-line-strong bg-surface p-1", className)}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className={cx(
            "min-h-target rounded-control border px-3 text-sm",
            o.value === value
              ? "border-accent bg-accent-band font-semibold text-accent"
              : "border-transparent text-ink hover:bg-notice",
          )}
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
