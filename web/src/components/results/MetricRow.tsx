/**
 * One measurement. Every text comes verbatim from the API's result:
 *
 * - first line: `name` on the left, `value_text` on the right (tabular figures);
 * - second line: `reference.label` and `reference.text`, then `status_text` (--accent at
 *   weight 600 when above / below the range, --ink-2 otherwise; no icons);
 * - the range bar when the metric has a range and a within / above / below status;
 * - `confidence_text` when confidence is low and each flag's `text`, always visible;
 * - a tap on the first line (name, value and a chevron at the end) expands `description`.
 */
import * as Collapsible from "@radix-ui/react-collapsible";
import { ICON } from "../ui/icon";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Metric } from "../../api/schemas";
import { cx } from "../ui/cx";
import { isRangeBarStatus, RangeBar } from "./RangeBar";

export function MetricRow({ metric }: { metric: Metric }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = metric.reference;
  const outOfRange = metric.status === "above" || metric.status === "below";
  const bar =
    ref !== null && ref.min !== null && ref.max !== null && metric.value !== null && isRangeBarStatus(metric.status)
      ? { value: metric.value, min: ref.min, max: ref.max, status: metric.status }
      : null;

  return (
    <li className="border-b border-line py-3 last:border-b-0" data-status={metric.status}>
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger className="flex w-full items-baseline gap-3 text-left">
          <span className="min-w-0 flex-1 font-medium">{metric.name}</span>{" "}
          {/* the space keeps name and value apart in the button's accessible name */}
          {/* Values with unit words ("6.2% of eye spacing") wrap within half the row. */}
          <span className="max-w-1/2 text-right tabular-nums">
            {metric.value_text ?? (
              <>
                <span aria-hidden="true">—</span>
                <span className="sr-only">{t("results.noValue")}</span>
              </>
            )}
          </span>
          {/* A fixed column at the row's end: the chevron never wraps with a long name. */}
          <ChevronDown
            {...ICON}
            size={20}
            className={cx("shrink-0 self-center text-ink-2 transition-transform", open && "rotate-180")}
          />
        </Collapsible.Trigger>
        <p className="text-sm text-ink-2">
          {ref && (
            <>
              <span>{ref.label}</span> <span className="tabular-nums">{ref.text}</span>
              <span aria-hidden="true"> ·</span>{" "}
            </>
          )}
          <span className={outOfRange ? "font-semibold text-accent" : "text-ink-2"}>{metric.status_text}</span>
        </p>
        {bar && <RangeBar {...bar} />}
        {metric.confidence === "low" && <p className="mt-1 text-sm text-ink-2">{metric.confidence_text}</p>}
        {metric.flags.map((f) => (
          <p key={f.key} className="mt-1 text-sm text-ink-2">
            {f.text}
          </p>
        ))}
        <Collapsible.Content>
          <p className="mt-2 text-sm text-ink-2">{metric.description}</p>
        </Collapsible.Content>
      </Collapsible.Root>
    </li>
  );
}
