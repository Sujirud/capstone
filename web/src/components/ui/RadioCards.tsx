/**
 * A single-choice question as full-width rows (Radix RadioGroup: arrow keys move the
 * choice, one tab stop). The group is labelled by the screen's heading or a legend.
 */
import * as RadioGroup from "@radix-ui/react-radio-group";
import { useId, type Ref } from "react";
import { cx } from "./cx";

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  lang?: string;
}

export interface RadioCardsProps<T extends string> {
  options: ReadonlyArray<RadioOption<T>>;
  value: T | null;
  onChange: (value: T) => void;
  labelledBy: string;
  describedBy?: string;
  error?: string | null;
  groupRef?: Ref<HTMLDivElement>;
}

export function RadioCards<T extends string>({
  options, value, onChange, labelledBy, describedBy, error, groupRef,
}: RadioCardsProps<T>) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div>
      <RadioGroup.Root
        ref={groupRef}
        value={value ?? ""}
        onValueChange={(v) => onChange(v as T)}
        aria-labelledby={labelledBy}
        aria-describedby={[describedBy, error ? errorId : null].filter(Boolean).join(" ") || undefined}
        aria-invalid={error ? true : undefined}
        className="grid gap-2"
      >
        {options.map((o) => {
          const itemId = `${id}-${o.value}`;
          const checked = value === o.value;
          return (
            <label
              key={o.value}
              htmlFor={itemId}
              className={cx(
                "flex min-h-12 cursor-pointer items-center gap-3 rounded-control border bg-surface px-4",
                checked ? "border-accent" : "border-line-strong",
              )}
            >
              <RadioGroup.Item
                id={itemId}
                value={o.value}
                className={cx(
                  "grid size-6 shrink-0 place-items-center rounded-full border bg-surface",
                  checked ? "border-accent" : "border-line-strong",
                )}
              >
                <RadioGroup.Indicator className="block size-3 rounded-full bg-accent" />
              </RadioGroup.Item>
              <span lang={o.lang} className={checked ? "font-medium" : undefined}>
                {o.label}
              </span>
            </label>
          );
        })}
      </RadioGroup.Root>
      {error && (
        <p id={errorId} className="mt-2 text-sm font-medium text-error">
          {error}
        </p>
      )}
    </div>
  );
}
