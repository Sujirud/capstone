/**
 * The top bar: back, the step text and the language control. The step
 * shows as text plus a thin progress line along the bar's lower edge; no numbered circles.
 */
import { ArrowLeft } from "lucide-react";
import { ICON } from "../ui/icon";
import { useTranslation } from "react-i18next";
import { cx } from "../ui/cx";
import { LanguageToggle } from "./LanguageToggle";

export interface Step {
  current: number;
  total: number;
  label: string;
}

export interface TopBarProps {
  onBack?: (() => void) | null;
  step?: Step | null;
  wide?: boolean;
}

export function TopBar({ onBack, step, wide = false }: TopBarProps) {
  const { t } = useTranslation();
  return (
    <header className="border-b border-line bg-paper print:hidden">
      <div className={cx("relative mx-auto flex min-h-12 w-full items-center gap-2 px-2 py-1", wide ? "max-w-wide" : "max-w-page")}>
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label={t("nav.back")}
            className="inline-flex size-target shrink-0 items-center justify-center rounded-control text-ink hover:bg-notice"
          >
            <ArrowLeft {...ICON} size={24} />
          </button>
        ) : (
          <span className="w-2 shrink-0" />
        )}
        <p className="min-w-0 flex-1 text-sm text-ink-2">
          {step ? t("steps.indicator", { current: step.current, total: step.total, label: step.label }) : null}
        </p>
        <LanguageToggle />
        {step && (
          // The step as a thin line along the bar's lower edge, over the hairline.
          <div aria-hidden="true" className="absolute inset-x-0 -bottom-px h-[2px]">
            <div className="h-full bg-ink-2" style={{ width: `${(step.current / step.total) * 100}%` }} />
          </div>
        )}
      </div>
    </header>
  );
}
