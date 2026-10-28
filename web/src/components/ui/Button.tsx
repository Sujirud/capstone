/**
 * Buttons: primary is solid ink (one per screen), secondary is outlined,
 * tertiary is a text link in the accent. Labels are verbs. Every button is at least
 * 44 × 44 px.
 */
import type { ComponentProps } from "react";
import { Link, type LinkProps } from "react-router";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "tertiary";

const BASE =
  "inline-flex min-h-target min-w-target items-center justify-center gap-2 rounded-control text-base " +
  "font-medium transition-colors disabled:cursor-not-allowed";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-ink px-4 text-surface hover:bg-ink-2 disabled:bg-line disabled:text-ink-3",
  secondary: "border border-line-strong bg-surface px-4 text-ink hover:bg-notice disabled:text-ink-3",
  tertiary: "px-1 text-accent underline underline-offset-[3px] hover:text-ink disabled:text-ink-3 disabled:no-underline",
};

export function buttonClasses(variant: ButtonVariant, className?: string): string {
  return cx(BASE, VARIANTS[variant], className);
}

export type ButtonProps = ComponentProps<"button"> & { variant?: ButtonVariant };

export function Button({ variant = "secondary", className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={buttonClasses(variant, className)} {...rest} />;
}

export type LinkButtonProps = LinkProps & { variant?: ButtonVariant };

/** Navigation that looks like a button. */
export function LinkButton({ variant = "secondary", className, ...rest }: LinkButtonProps) {
  return <Link className={buttonClasses(variant, cx("no-underline", className))} {...rest} />;
}
