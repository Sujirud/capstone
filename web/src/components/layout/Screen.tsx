/**
 * One screen: skip link, top bar, the main column (640 px max) with exactly one h1, and
 * the optional sticky action bar. On every step change focus moves to the new screen's
 * heading, except on the page's first screen, and the document title follows it.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import { cx } from "../ui/cx";
import { ActionBar } from "./ActionBar";
import { SkipLink } from "./SkipLink";
import { TopBar, type Step } from "./TopBar";

/** The router location of the first screen shown after the page loaded. */
let firstScreenKey: string | undefined;

export interface ScreenProps {
  title: string;
  /** id for the heading, so a form control can be labelled by it. */
  headingId?: string;
  step?: Step | null;
  onBack?: (() => void) | null;
  actions?: ReactNode;
  wide?: boolean;
  children?: ReactNode;
}

export function Screen({ title, headingId, step, onBack, actions, wide = false, children }: ScreenProps) {
  const { t } = useTranslation();
  const heading = useRef<HTMLHeadingElement>(null);

  const { key } = useLocation();
  useEffect(() => {
    // A fresh page load leaves focus at the start, so the skip link is the first Tab stop;
    // every later step moves focus to its heading.
    firstScreenKey ??= key;
    if (key !== firstScreenKey) heading.current?.focus();
  }, [key]);

  useEffect(() => {
    document.title = t("app.documentTitle", { screen: title });
  }, [t, title]);

  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <TopBar onBack={onBack} step={step} wide={wide} />
      <main
        id="main"
        tabIndex={-1}
        className={cx("mx-auto w-full flex-1 px-4 pt-6 pb-8 focus:outline-none", wide ? "max-w-wide" : "max-w-page")}
      >
        <h1 ref={heading} id={headingId} tabIndex={-1} data-screen-heading className="mb-4 text-2xl">
          {title}
        </h1>
        {children}
      </main>
      {actions && <ActionBar wide={wide}>{actions}</ActionBar>}
    </div>
  );
}
