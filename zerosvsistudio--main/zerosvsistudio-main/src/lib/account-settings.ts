/**
 * The browser side of per-account settings: one store for the page, wired to Firebase (who is signed in) and to the database
 * (where the account's settings live). See account-settings-core.ts for the rules.
 */
import { useSyncExternalStore } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { supabase } from "@/integrations/supabase/client";
import { firebaseAuth } from "@/lib/firebase";
import { DEFAULT_SETTINGS, SettingsStore, type AccountSettings, type KeyValue, type Remote } from "@/lib/account-settings-core";
import { setSettingsBridge } from "@/lib/settings-bridge";

const browserStorage = (): KeyValue | null => {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
};

const remote: Remote = {
  async pull(uid) {
    const { data, error } = await supabase.from("zeros_user_settings").select("wallpaper, reasoning, memory_enabled").eq("user_id", uid).maybeSingle();
    if (error) throw error;
    return data ?? null;
  },
  async push(uid, s) {
    const { error } = await supabase.from("zeros_user_settings").upsert(
      { user_id: uid, wallpaper: s.wallpaper as never, reasoning: s.reasoning, memory_enabled: s.memoryEnabled, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (error) throw error;
  },
};

const store = new SettingsStore({ storage: browserStorage(), remote });
let started = false;

/** Starts listening to sign-in changes (once, in the browser). */
function start(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  store.preload();
  onAuthStateChanged(firebaseAuth, (user) => { void store.setAccount(user?.uid ?? null); });
  window.addEventListener("pagehide", () => { void store.flush(); });
}

/** The signed-in account's settings right now (the defaults when nobody is signed in). */
export function getSettings(): AccountSettings {
  start();
  return store.get();
}

/** Changes some of the signed-in account's settings; they are saved to the account and follow it to every device. */
export function updateSettings(patch: Partial<AccountSettings>): void {
  start();
  store.update(patch);
}

/** The settings of whoever is signed in, kept current as the account changes. */
export function useAccountSettings(): AccountSettings {
  return useSyncExternalStore(
    (listener) => { start(); return store.subscribe(listener); },
    () => store.get(),
    () => DEFAULT_SETTINGS,
  );
}

if (typeof window !== "undefined") setSettingsBridge({ read: () => getSettings(), write: (patch) => updateSettings(patch) });
