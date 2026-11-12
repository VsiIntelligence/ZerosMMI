/** Confirm and ask-for-text dialogs that return a promise, so the app never needs the browser's own plain popups. */
import { useSyncExternalStore } from "react";

export type ConfirmRequest = { kind: "confirm"; id: number; title: string; message: string; confirmLabel: string; cancelLabel: string; destructive: boolean; resolve: (ok: boolean) => void };
export type PromptRequest = { kind: "prompt"; id: number; title: string; message: string; initial: string; placeholder: string; confirmLabel: string; maxLength: number; resolve: (value: string | null) => void };
export type DialogRequest = ConfirmRequest | PromptRequest;

const EMPTY: DialogRequest[] = [];
let queue: DialogRequest[] = EMPTY;
let seq = 0;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export function confirmDialog(o: { title: string; message?: string; confirmLabel?: string; cancelLabel?: string; destructive?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { kind: "confirm", id: ++seq, title: o.title, message: o.message ?? "", confirmLabel: o.confirmLabel ?? "Confirm", cancelLabel: o.cancelLabel ?? "Cancel", destructive: o.destructive ?? false, resolve }];
    emit();
  });
}

export function promptDialog(o: { title: string; message?: string; initial?: string; placeholder?: string; confirmLabel?: string; maxLength?: number }): Promise<string | null> {
  return new Promise((resolve) => {
    queue = [...queue, { kind: "prompt", id: ++seq, title: o.title, message: o.message ?? "", initial: o.initial ?? "", placeholder: o.placeholder ?? "", confirmLabel: o.confirmLabel ?? "Save", maxLength: o.maxLength ?? 120, resolve }];
    emit();
  });
}

/** Called by the dialog host once a dialog has been answered. */
export function settleDialog(id: number): void {
  queue = queue.filter((d) => d.id !== id);
  if (!queue.length) queue = EMPTY;
  emit();
}

export function useDialogs(): DialogRequest[] {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => queue,
    () => EMPTY,
  );
}
