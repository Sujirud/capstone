/**
 * Every measurement of a result as one table: the report's
 * "measurement table", on screen and on paper. Rows are grouped by `area` in the API's order
 * (row-group headers), secondary metrics last under "More details". Every text is the core's,
 * verbatim; caveats (`confidence_text` when low, flag texts) stay under the name.
 *
 * Four columns from 640 px and in print; on a narrow screen the reference and status move
 * under the name, so nothing scrolls sideways. When every row has the same reference label
 * (today: the classical proportion reference), that label heads the column once, and the
 * cells hold the ranges; otherwise each cell holds its own label.
 */
import { useTranslation } from "react-i18next";
import type { Metric } from "../../api/schemas";
import { currentLanguage } from "../../i18n";
import { areaText } from "../../i18n/areas";
import { cx } from "../ui/cx";
import { groupByArea } from "./MeasurementSheet";

const WIDE = "hidden md:table-cell print:table-cell";
const NARROW = "md:hidden print:hidden";

function StatusText({ metric }: { metric: Metric }) {
  const out = metric.status === "above" || metric.status === "below";
  return <span className={out ? "font-semibold text-accent" : "text-ink-2"}>{metric.status_text}</span>;
}

function Reference({ metric, sharedLabel }: { metric: Metric; sharedLabel: string | null }) {
  const ref = metric.reference;
  if (!ref) return null;
  return (
    <>
      {ref.label !== sharedLabel && <span>{ref.label} </span>}
      <span className="tabular-nums">{ref.text}</span>
    </>
  );
}

function Row({ metric, sharedLabel }: { metric: Metric; sharedLabel: string | null }) {
  const { t } = useTranslation();
  return (
    <tr className="break-inside-avoid border-t border-line align-top" data-status={metric.status}>
      <th scope="row" className="py-2 pr-3 pl-3 text-left font-normal">
        <span className="font-medium">{metric.name}</span>
        {metric.confidence === "low" && <span className="block text-sm text-ink-2">{metric.confidence_text}</span>}
        {metric.flags.map((f) => (
          <span key={f.key} className="block text-sm text-ink-2">
            {f.text}
          </span>
        ))}
        <span className={cx("block text-sm text-ink-2", NARROW)}>
          {/* On a narrow screen there is no column header: the label goes with the range. */}
          <Reference metric={metric} sharedLabel={null} />
          {metric.reference && <span aria-hidden="true"> · </span>}
          <StatusText metric={metric} />
        </span>
      </th>
      <td className="py-2 pr-3 text-right tabular-nums">
        {metric.value_text ?? (
          <>
            <span aria-hidden="true">—</span>
            <span className="sr-only">{t("results.noValue")}</span>
          </>
        )}
      </td>
      <td className={cx("py-2 pr-3 text-sm text-ink-2", WIDE)}>
        <Reference metric={metric} sharedLabel={sharedLabel} />
      </td>
      <td className={cx("py-2 pr-3 text-sm", WIDE)}>
        <StatusText metric={metric} />
      </td>
    </tr>
  );
}

function Group({ title, metrics, sharedLabel }: { title: string; metrics: Array<[string, Metric]>; sharedLabel: string | null }) {
  return (
    <tbody>
      <tr className="break-after-avoid">
        <th scope="rowgroup" colSpan={4} className="px-3 pt-4 pb-1 text-left text-base font-semibold">
          {title}
        </th>
      </tr>
      {metrics.map(([id, m]) => (
        <Row key={id} metric={m} sharedLabel={sharedLabel} />
      ))}
    </tbody>
  );
}

export function MeasurementTable({ metrics, labelledBy }: { metrics: Record<string, Metric>; labelledBy: string }) {
  const { t } = useTranslation();
  const language = currentLanguage();
  const entries = Object.entries(metrics);
  const primary = groupByArea(entries.filter(([, m]) => m.role === "primary"));
  const secondary = groupByArea(entries.filter(([, m]) => m.role === "secondary"));
  const title = (area: string | null) => areaText(language, area) ?? t("results.otherArea");
  const labels = new Set(entries.flatMap(([, m]) => (m.reference ? [m.reference.label] : [])));
  const sharedLabel = labels.size === 1 ? [...labels][0]! : null;
  return (
    <table aria-labelledby={labelledBy} className="w-full border-collapse border border-line bg-surface">
      <thead>
        <tr className="text-sm text-ink-2">
          <th scope="col" className="px-3 py-2 text-left font-medium">
            {t("report.table.measurement")}
          </th>
          <th scope="col" className="py-2 pr-3 text-right font-medium">
            {t("report.table.value")}
          </th>
          <th scope="col" className={cx("py-2 pr-3 text-left font-medium", WIDE)}>
            {sharedLabel ?? t("report.table.reference")}
          </th>
          <th scope="col" className={cx("py-2 pr-3 text-left font-medium", WIDE)}>
            {t("report.table.status")}
          </th>
        </tr>
      </thead>
      {primary.map((g) => (
        <Group key={g.area ?? ""} title={title(g.area)} metrics={g.metrics} sharedLabel={sharedLabel} />
      ))}
      {secondary.map((g) => (
        <Group key={`more-${g.area ?? ""}`} title={`${t("results.moreDetails")} · ${title(g.area)}`} metrics={g.metrics} sharedLabel={sharedLabel} />
      ))}
    </table>
  );
}
