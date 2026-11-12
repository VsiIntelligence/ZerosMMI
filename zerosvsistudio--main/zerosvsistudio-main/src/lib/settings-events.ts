/** Lets any part of the app open one of the available Settings pages. */
export type SettingsTab = "account" | "apps" | "appearance";
export const OPEN_SETTINGS_EVENT = "zeros-open-settings";

export function openSettings(tab: SettingsTab = "account"): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { tab } }));
}
