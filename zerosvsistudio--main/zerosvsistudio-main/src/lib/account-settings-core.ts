/**
 * Everything a person customises (wallpaper, reasoning level, the memory switch) belongs to their Google account:
 *
 *  - It is saved in the account's own row in the database, so it follows the account to every device.
 *  - It is cached in this browser under the account's id, so the page paints instantly, and a different account on the same
 *    browser never sees it. Switching or signing out clears the previous account's cache (unless a change has not reached the
 *    database yet, in which case it is kept, still under that account's id, until it has).
 *  - Nobody signed in (a guest, or the sign-in page) always sees the defaults, and nothing is saved.
 *
 * This file has no dependency on React, the database client or the browser, so it can be tested on its own.
 */
import { MAX_CUSTOM_BYTES, WALLPAPERS, isSafeImageDataUrl, type WallpaperChoice } from "@/lib/wallpapers";
import type { ReasoningLevelName } from "@/lib/zeros";

export type AccountSettings = { wallpaper: WallpaperChoice; reasoning: ReasoningLevelName; memoryEnabled: boolean };
export const DEFAULT_SETTINGS: AccountSettings = { wallpaper: { id: "tunnel" }, reasoning: "medium", memoryEnabled: true };

/** What the database holds (every column may be empty). */
export type RemoteRow = { wallpaper?: unknown; reasoning?: unknown; memory_enabled?: unknown } | null;

export interface Remote {
  pull(uid: string): Promise<RemoteRow>;
  push(uid: string, settings: AccountSettings): Promise<void>;
}

/** The few Storage methods used, so tests can pass a plain object. */
export interface KeyValue {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = "zeros:account:";
export const cacheKey = (uid: string): string => `${PREFIX}${uid}:settings`;
export const LAST_ACCOUNT_KEY = "zeros:last-account";
/** The keys older versions shared between every account on a browser. They are removed, never adopted. */
export const LEGACY_KEYS = ["zeros-wallpaper", "zeros-reasoning", "zeros_memory_enabled"] as const;

const isLevel = (v: unknown): v is ReasoningLevelName => v === "fast" || v === "medium" || v === "complex";

/** Turns anything (a cached string, a database row) into valid settings. Never throws; anything unusable becomes the default. */
export function sanitize(raw: unknown): AccountSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let wallpaper: WallpaperChoice = { id: "tunnel" };
  const w = o["wallpaper"] as { id?: unknown; dataUrl?: unknown } | null | undefined;
  if (w && typeof w === "object") {
    if (w.id === "custom") {
      if (typeof w.dataUrl === "string" && isSafeImageDataUrl(w.dataUrl)) wallpaper = { id: "custom", dataUrl: w.dataUrl };
    } else if (WALLPAPERS.some((p) => p.id === w.id)) {
      wallpaper = { id: w.id as WallpaperChoice["id"] };
    }
  }
  const memory = o["memoryEnabled"] ?? o["memory_enabled"];
  return {
    wallpaper,
    reasoning: isLevel(o["reasoning"]) ? o["reasoning"] : DEFAULT_SETTINGS.reasoning,
    memoryEnabled: typeof memory === "boolean" ? memory : DEFAULT_SETTINGS.memoryEnabled,
  };
}

type Cached = { settings: AccountSettings; dirty: boolean };

export function readCache(storage: KeyValue | null, uid: string): Cached | null {
  try {
    const raw = storage?.getItem(cacheKey(uid));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { settings?: unknown; dirty?: unknown };
    return { settings: sanitize(parsed.settings), dirty: parsed.dirty === true };
  } catch {
    return null;
  }
}

export function writeCache(storage: KeyValue | null, uid: string, settings: AccountSettings, dirty: boolean): void {
  try {
    storage?.setItem(cacheKey(uid), JSON.stringify({ settings, dirty }));
  } catch {
    /* storage full or blocked: the database still has it, and this visit keeps it in memory */
  }
}

/** Removes the shared keys older versions used, and every other account's synced cache. Returns how many entries went. */
export function tidyStorage(storage: KeyValue | null, keepUid: string | null): number {
  if (!storage) return 0;
  let removed = 0;
  try {
    for (const key of LEGACY_KEYS) if (storage.getItem(key) !== null) { storage.removeItem(key); removed++; }
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key || !key.startsWith(PREFIX) || !key.endsWith(":settings")) continue;
      const uid = key.slice(PREFIX.length, key.length - ":settings".length);
      if (uid === keepUid) continue;
      if (readCache(storage, uid)?.dirty) continue;   /* a change that has not reached the database yet stays, under its own account */
      doomed.push(key);
    }
    for (const key of doomed) { storage.removeItem(key); removed++; }
  } catch {
    /* nothing to tidy */
  }
  return removed;
}

export type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

const same = (a: AccountSettings, b: AccountSettings): boolean => JSON.stringify(a) === JSON.stringify(b);

export class SettingsStore {
  private uid: string | null = null;
  private state: AccountSettings = DEFAULT_SETTINGS;
  private generation = 0;
  private timer: unknown = null;
  private readonly listeners = new Set<() => void>();
  private readonly storage: KeyValue | null;
  private readonly remote: Remote;
  private readonly timers: Timers;
  private readonly delay: number;

  constructor(o: { storage: KeyValue | null; remote: Remote; timers?: Timers; pushDelayMs?: number }) {
    this.storage = o.storage;
    this.remote = o.remote;
    this.timers = o.timers ?? realTimers;
    this.delay = o.pushDelayMs ?? 400;
  }

  /** The signed-in account's settings, or the defaults when nobody is signed in. */
  get(): AccountSettings { return this.state; }
  get account(): string | null { return this.uid; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void { this.listeners.forEach((l) => l()); }

  /** The account that was signed in the last time on this browser, so the first paint can use its cache while sign-in is restored. */
  lastAccount(): string | null {
    try { return this.storage?.getItem(LAST_ACCOUNT_KEY) ?? null; } catch { return null; }
  }

  /** Paints from the cache of the last account before Firebase has confirmed who is signed in. Replaced as soon as it does. */
  preload(): void {
    const uid = this.lastAccount();
    if (!uid || this.uid) return;
    const cached = readCache(this.storage, uid);
    if (cached) { this.state = cached.settings; this.emit(); }
  }

  /** The signed-in person changed (null = nobody). Loads that account's cache at once, then brings it up to date from the database. */
  async setAccount(uid: string | null): Promise<void> {
    if (uid === this.uid && (uid !== null || this.state === DEFAULT_SETTINGS)) return;
    this.timers.clear(this.timer);
    this.timer = null;
    this.uid = uid;
    const gen = ++this.generation;
    tidyStorage(this.storage, uid);
    try {
      if (uid) this.storage?.setItem(LAST_ACCOUNT_KEY, uid); else this.storage?.removeItem(LAST_ACCOUNT_KEY);
    } catch { /* private mode */ }
    if (!uid) { this.state = DEFAULT_SETTINGS; this.emit(); return; }

    const cached = readCache(this.storage, uid);
    this.state = cached?.settings ?? DEFAULT_SETTINGS;
    this.emit();

    try {
      const row = await this.remote.pull(uid);
      if (gen !== this.generation) return;   /* the account changed again while this was loading */
      if (row) {
        if (cached?.dirty) { await this.pushNow(uid, gen); return; }   /* this device has a newer change that never reached the database */
        const fresh = sanitize(row);
        if (!same(fresh, this.state)) { this.state = fresh; this.emit(); }
        writeCache(this.storage, uid, fresh, false);
      } else if (!same(this.state, DEFAULT_SETTINGS)) {
        await this.pushNow(uid, gen);
      }
    } catch {
      /* offline or the database is unreachable: this device's copy keeps working and is saved on the next change */
    }
  }

  /** Changes some settings for the signed-in account. With nobody signed in the change lasts only until the page closes. */
  update(patch: Partial<AccountSettings>): void {
    /* Each field is checked on its own: an invalid value is ignored and the previous one stays, it never resets to a default. */
    const clean: Partial<AccountSettings> = {};
    if (patch.wallpaper !== undefined) {
      const w = sanitize({ wallpaper: patch.wallpaper }).wallpaper;
      if (w.id === patch.wallpaper.id && (w.id !== "custom" || w.dataUrl === patch.wallpaper.dataUrl)) clean.wallpaper = w;
    }
    if (isLevel(patch.reasoning)) clean.reasoning = patch.reasoning;
    if (typeof patch.memoryEnabled === "boolean") clean.memoryEnabled = patch.memoryEnabled;
    const next: AccountSettings = { ...this.state, ...clean };
    if (same(next, this.state)) return;
    this.state = next;
    this.emit();
    const uid = this.uid;
    if (!uid) return;
    writeCache(this.storage, uid, next, true);
    this.timers.clear(this.timer);
    this.timer = this.timers.set(() => { void this.pushNow(uid, this.generation); }, this.delay);
  }

  /** Saves right now (used by tests, and before the page unloads). */
  async flush(): Promise<void> {
    if (!this.uid) return;
    this.timers.clear(this.timer);
    this.timer = null;
    await this.pushNow(this.uid, this.generation);
  }

  private async pushNow(uid: string, gen: number): Promise<void> {
    const sending = this.state;
    try {
      await this.remote.push(uid, sending);
      if (gen === this.generation && uid === this.uid && same(sending, this.state)) writeCache(this.storage, uid, sending, false);
    } catch {
      /* stays marked unsaved; the next change or visit tries again */
    }
  }
}

export { MAX_CUSTOM_BYTES };
