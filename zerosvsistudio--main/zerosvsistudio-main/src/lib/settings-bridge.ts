/**
 * The signed-in account's settings, read and written through functions the browser registers at start-up (see
 * account-settings.ts). Pure modules, such as the request builder and the memory client, use this instead of importing the
 * browser runtime, so they stay light and the test suite can load them.
 */
import { DEFAULT_SETTINGS, type AccountSettings } from "@/lib/account-settings-core";

type Bridge = { read: () => AccountSettings; write: (patch: Partial<AccountSettings>) => void };

let bridge: Bridge = { read: () => DEFAULT_SETTINGS, write: () => undefined };

export function setSettingsBridge(next: Bridge): void {
  bridge = next;
}

export const readSettings = (): AccountSettings => bridge.read();
export const writeSettings = (patch: Partial<AccountSettings>): void => bridge.write(patch);
