/** A collapsed section with a text trigger (Radix Collapsible: aria-expanded, aria-controls). */
import * as Collapsible from "@radix-ui/react-collapsible";
import { ICON } from "./icon";
import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cx } from "./cx";

export interface DisclosureProps {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  triggerClassName?: string;
}

export function Disclosure({ title, children, defaultOpen = false, className, triggerClassName }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={className}>
      <Collapsible.Trigger
        className={cx("flex min-h-target w-full items-center gap-2 text-left font-medium text-ink", triggerClassName)}
      >
        <ChevronDown
          {...ICON}
          size={20}
          className={cx("shrink-0 transition-transform", open && "rotate-180")}
        />
        <span>{title}</span>
      </Collapsible.Trigger>
      <Collapsible.Content>{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
