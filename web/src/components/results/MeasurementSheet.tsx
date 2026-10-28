/**
 * The measurement sheet: one --surface sheet, metrics grouped by
 * `area` in the order the API returns them, rows separated by hairlines. `role:
 * secondary` metrics go in a collapsed "More details" section at the end.
 */
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { Metric } from "../../api/schemas";
import { currentLanguage } from "../../i18n";
import { areaText } from "../../i18n/areas";
import { Disclosure } from "../ui/Disclosure";
import { MetricRow } from "./MetricRow";

interface AreaGroup {
  area: string | null;
  metrics: Array<[string, Metric]>;
}

/** Groups in order of each area's first metric; metrics keep the API's order. */
export function groupByArea(entries: Array<[string, Metric]>): AreaGroup[] {
  const groups = new Map<string | null, AreaGroup>();
  for (const entry of entries) {
    const area = entry[1].area;
    let group = groups.get(area);
    if (!group) {
      group = { area, metrics: [] };
      groups.set(area, group);
    }
    group.metrics.push(entry);
  }
  return [...groups.values()];
}

function AreaSection({ group, level }: { group: AreaGroup; level: 2 | 3 }) {
  const { t } = useTranslation();
  const id = useId();
  const title = areaText(currentLanguage(), group.area) ?? t("results.otherArea");
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby={id} className="px-4 pt-4">
      <Heading id={id} className="text-lg">
        {title}
      </Heading>
      <ul>
        {group.metrics.map(([metricId, metric]) => (
          <MetricRow key={metricId} metric={metric} />
        ))}
      </ul>
    </section>
  );
}

export function MeasurementSheet({ metrics }: { metrics: Record<string, Metric> }) {
  const { t } = useTranslation();
  const entries = Object.entries(metrics);
  const primary = groupByArea(entries.filter(([, m]) => m.role === "primary"));
  const secondary = groupByArea(entries.filter(([, m]) => m.role === "secondary"));
  return (
    <div className="border border-line bg-surface">
      {primary.map((g) => (
        <AreaSection key={g.area ?? ""} group={g} level={2} />
      ))}
      {secondary.length > 0 && (
        <div className="mt-2 border-t border-line px-4 py-2">
          <Disclosure title={<span className="text-lg font-semibold">{t("results.moreDetails")}</span>}>
            <div className="-mx-4">
              {secondary.map((g) => (
                <AreaSection key={g.area ?? ""} group={g} level={3} />
              ))}
            </div>
          </Disclosure>
        </div>
      )}
    </div>
  );
}
