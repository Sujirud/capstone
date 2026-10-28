/**
 * Which way the nose points in the side photo: two illustrated choices, right
 * by default. It is shown before the photo is taken ("the side shown in the app", as the
 * core's `profile_facing` hint says), and again with the photo, to check it.
 */
import * as RadioGroup from "@radix-ui/react-radio-group";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { Facing } from "../../api/schemas";
import { FacingDrawing } from "../../components/illustrations/Profile";
import { cx } from "../../components/ui/cx";

const FACINGS: readonly Facing[] = ["left", "right"];

export function FacingChoice({
  value,
  onChange,
  help = "help",
  className,
}: {
  value: Facing;
  onChange(facing: Facing): void;
  /** "help" before the photo is taken; "check" next to the photo. */
  help?: "help" | "check";
  className?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className={className} data-testid="facing">
      <p id={`${id}-label`} className="font-medium">
        {t("profile.facing.label")}
      </p>
      <p id={`${id}-help`} className="mb-3 text-ink-2">
        {t(`profile.facing.${help}`)}
      </p>
      <RadioGroup.Root
        value={value}
        onValueChange={(v) => onChange(v as Facing)}
        orientation="horizontal"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        className="grid max-w-field grid-cols-2 gap-3"
      >
        {FACINGS.map((facing) => {
          const itemId = `${id}-${facing}`;
          const checked = value === facing;
          return (
            <label
              key={facing}
              htmlFor={itemId}
              className={cx(
                "grid cursor-pointer justify-items-center gap-2 rounded-control border bg-surface px-3 pt-2 pb-3",
                checked ? "border-accent" : "border-line-strong",
              )}
            >
              <span className="block w-full max-w-[8rem]">
                <FacingDrawing facing={facing} />
              </span>
              <span className="flex min-h-6 items-center gap-2">
                <RadioGroup.Item
                  id={itemId}
                  value={facing}
                  className={cx(
                    "grid size-6 shrink-0 place-items-center rounded-full border bg-surface",
                    checked ? "border-accent" : "border-line-strong",
                  )}
                >
                  <RadioGroup.Indicator className="block size-3 rounded-full bg-accent" />
                </RadioGroup.Item>
                <span className={checked ? "font-medium" : undefined}>{t(`profile.facing.${facing}`)}</span>
              </span>
            </label>
          );
        })}
      </RadioGroup.Root>
    </div>
  );
}
