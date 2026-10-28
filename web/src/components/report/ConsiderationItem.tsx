/**
 * One discussion topic of the report: the core's `area_text`, `severity_text`,
 * `finding`, its considerations, the measurements behind it (name, value, reference and
 * status) and `consult`, all verbatim and in the API's order. The severity is a line of
 * text, not a badge; out-of-range status text is emphasised as on the sheet.
 */
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { Consideration } from "../../api/schemas";

export function ConsiderationItem({ item }: { item: Consideration }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <article aria-labelledby={id} className="break-inside-avoid border-t border-line py-4" data-rule={item.rule_id}>
      <h3 id={id} className="text-lg">
        {item.area_text}
      </h3>
      <p className="text-sm text-ink-2">{item.severity_text}</p>
      <p className="mt-2">{item.finding}</p>
      {item.considerations.length > 0 && (
        <>
          <p className="mt-3 font-medium">{t("report.topics")}</p>
          <ul className="list-disc pl-6">
            {item.considerations.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </>
      )}
      {item.measurements.length > 0 && (
        <>
          <p className="mt-3 font-medium">{t("report.measured")}</p>
          <ul className="mt-1 border border-line bg-surface px-3">
            {item.measurements.map((m) => {
              const out = m.status === "above" || m.status === "below";
              return (
                <li key={m.id} className="border-b border-line py-2 last:border-b-0" data-status={m.status}>
                  <p className="flex items-baseline gap-3">
                    <span className="min-w-0 flex-1">{m.name}</span>
                    <span className="tabular-nums">{m.value_text ?? "—"}</span>
                  </p>
                  <p className="text-sm text-ink-2">
                    {m.reference && (
                      <>
                        <span>{m.reference.label}</span> <span className="tabular-nums">{m.reference.text}</span>
                        <span aria-hidden="true"> ·</span>{" "}
                      </>
                    )}
                    <span className={out ? "font-semibold text-accent" : undefined}>{m.status_text}</span>
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="mt-3 text-ink-2">{item.consult}</p>
    </article>
  );
}
