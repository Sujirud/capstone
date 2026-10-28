/**
 * A text input with a visible label, optional help and an inline error in --error.
 * Help and error are linked with aria-describedby.
 */
import { useId, type ComponentProps, type Ref } from "react";
import { cx } from "./cx";

export type TextFieldProps = Omit<ComponentProps<"input">, "id"> & {
  label: string;
  help?: string;
  error?: string | null;
  inputRef?: Ref<HTMLInputElement>;
  /** Classes for the input only, e.g. a short width for an age. */
  inputClassName?: string;
};

export function TextField({ label, help, error, inputRef, className, inputClassName, ...input }: TextFieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="block font-medium">
        {label}
      </label>
      {help && (
        <p id={helpId} className="mt-1 text-sm text-ink-2">
          {help}
        </p>
      )}
      <input
        id={id}
        ref={inputRef}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(
          "mt-2 block min-h-12 w-full rounded-control border bg-surface px-3 text-base text-ink",
          error ? "border-error" : "border-line-strong",
          inputClassName,
        )}
        {...input}
      />
      {error && (
        <p id={errorId} className="mt-2 text-sm font-medium text-error">
          {error}
        </p>
      )}
    </div>
  );
}
