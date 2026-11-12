/** Small notifications that appear at the top of the screen and leave by themselves. */
import { useSyncExternalStore } from "react";

export type ToastTone = "success" | "error" | "info";
export type ToastItem = { id: number; tone: ToastTone; title: string; text?: string };

const EMPTY: ToastItem[] = [];
let items: ToastItem[] = EMPTY;
let seq = 0;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export function dismissToast(id: number): void {
  items = items.filter((t) => t.id !== id);
  if (!items.length) items = EMPTY;
  emit();
}

export function toast(t: { tone?: ToastTone; title: string; text?: string }, ms = 4800): number {
  const id = ++seq;
  items = [...items.slice(-2), { id, tone: t.tone ?? "info", title: t.title, ...(t.text ? { text: t.text } : {}) }];
  emit();
  if (typeof window !== "undefined") window.setTimeout(() => dismissToast(id), ms);
  return id;
}

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => items,
    () => EMPTY,
  );
}
