/**
 * A confirmation (Radix Dialog: focus trapped and returned, Escape closes, labelled by its
 * title). Used before an action loses results: a new scan, or a language switch that
 * analyzes the photo again.
 */
import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { Button } from "./Button";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  body: ReactNode;
  confirm: string;
  cancel: string;
  onConfirm(): void;
}

export function ConfirmDialog({ open, onOpenChange, title, body, confirm, cancel, onConfirm }: ConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-30 bg-ink/40" />
        <Dialog.Content className="fixed inset-x-4 top-1/2 z-40 mx-auto max-w-field -translate-y-1/2 border border-line bg-surface p-6">
          <Dialog.Title className="text-xl font-semibold">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-3 text-ink-2">{body}</div>
          </Dialog.Description>
          <div className="mt-6 flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <Dialog.Close asChild>
              <Button variant="secondary">{cancel}</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              onClick={() => {
                onOpenChange(false);
                onConfirm();
              }}
            >
              {confirm}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
