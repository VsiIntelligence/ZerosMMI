/**
 * Per-account settings: the wallpaper, the reasoning level and the memory switch belong to one Google account, follow it to
 * every device, and are never shown to another account on the same browser.
 *
 *   npx tsx tests/account-settings.mts
 */
import {
  DEFAULT_SETTINGS, LAST_ACCOUNT_KEY, LEGACY_KEYS, SettingsStore, cacheKey, readCache, sanitize, tidyStorage,
  type AccountSettings, type KeyValue, type Remote, type RemoteRow, type Timers,
} from "../src/lib/account-settings-core.ts";
import { isSafeImageDataUrl, wallpaperStyle } from "../src/lib/wallpapers.ts";

let pass = 0, fail = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) pass++; else { fail++; failures.push(name); }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  [${detail}]` : ""}`);
};
const section = (s: string) => console.log(`\n== ${s}`);

/** A browser's localStorage. */
class Storage implements KeyValue {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

/** The database: one row per account, shared by every device. */
class Database {
  rows = new Map<string, Record<string, unknown>>();
  pushes: { uid: string; settings: AccountSettings }[] = [];
  offline = false;
  slow: Promise<void> | null = null;
  remote(): Remote {
    return {
      pull: async (uid): Promise<RemoteRow> => {
        if (this.slow) await this.slow;
        if (this.offline) throw new Error("offline");
        return (this.rows.get(uid) as RemoteRow) ?? null;
      },
      push: async (uid, s) => {
        if (this.offline) throw new Error("offline");
        this.pushes.push({ uid, settings: s });
        this.rows.set(uid, { wallpaper: s.wallpaper, reasoning: s.reasoning, memory_enabled: s.memoryEnabled });
      },
    };
  }
}

/** Timers that run only when the test says so. */
class FakeTimers implements Timers {
  private next = 1;
  pending = new Map<number, () => void>();
  set(fn: () => void) { const id = this.next++; this.pending.set(id, fn); return id; }
  clear(h: unknown) { this.pending.delete(h as number); }
  run() { const fns = [...this.pending.values()]; this.pending.clear(); fns.forEach((f) => f()); }
}

const device = (db: Database, storage = new Storage()) => {
  const timers = new FakeTimers();
  const store = new SettingsStore({ storage, remote: db.remote(), timers });
  return { store, storage, timers };
};
const aurora: AccountSettings["wallpaper"] = { id: "aurora" };
const PNG = "data:image/png;base64,iVBORw0KGgo=";

async function main(): Promise<void> {
  section("What counts as a valid setting");
  check("only real raster image data is accepted as a custom wallpaper", isSafeImageDataUrl(PNG) && !isSafeImageDataUrl("data:image/svg+xml;base64,PHN2Zz4=") && !isSafeImageDataUrl("javascript:alert(1)") && !isSafeImageDataUrl('data:image/png;base64,AAAA"); background:url(x'));
  check("an oversized custom wallpaper is refused", !isSafeImageDataUrl(`data:image/png;base64,${"A".repeat(4_000_000)}`));
  check("preset wallpapers become a style object and the tunnel becomes none", wallpaperStyle({ id: "tunnel" }) === null && typeof wallpaperStyle({ id: "aurora" })?.["background"] === "string" && wallpaperStyle({ id: "custom" }) === null);
  check("anything unusable becomes the default instead of an error", JSON.stringify(sanitize(null)) === JSON.stringify(DEFAULT_SETTINGS) && JSON.stringify(sanitize("nope")) === JSON.stringify(DEFAULT_SETTINGS) && sanitize({ wallpaper: { id: "custom", dataUrl: "javascript:x" } }).wallpaper.id === "tunnel" && sanitize({ wallpaper: { id: "no-such" } }).wallpaper.id === "tunnel");
  check("a database row is read with its own column names", (() => { const s = sanitize({ wallpaper: { id: "ember" }, reasoning: "complex", memory_enabled: false }); return s.wallpaper.id === "ember" && s.reasoning === "complex" && s.memoryEnabled === false; })());
  check("an unknown reasoning level falls back to Medium", sanitize({ reasoning: "ultra" }).reasoning === "medium" && sanitize({ reasoning: 3 }).reasoning === "medium");

  section("Two Google accounts on one browser");
  const db = new Database();
  const shared = new Storage();
  const one = device(db, shared);
  shared.setItem("zeros-wallpaper", JSON.stringify({ id: "paper" }));       /* what older versions kept for everyone */
  shared.setItem("zeros-reasoning", "complex");
  shared.setItem("zeros_memory_enabled", "0");
  await one.store.setAccount("uid-ann");
  check("the shared keys older versions used are removed and never adopted by an account", LEGACY_KEYS.every((k) => shared.getItem(k) === null) && JSON.stringify(one.store.get()) === JSON.stringify(DEFAULT_SETTINGS));
  one.store.update({ wallpaper: aurora, reasoning: "fast", memoryEnabled: false });
  await one.store.flush();
  check("Ann's choices are saved to her account in the database", JSON.stringify(db.rows.get("uid-ann")) === JSON.stringify({ wallpaper: aurora, reasoning: "fast", memory_enabled: false }));
  check("and cached in this browser under her account id only", readCache(shared, "uid-ann")?.settings.wallpaper.id === "aurora" && [...shared.data.keys()].every((k) => k === cacheKey("uid-ann") || k === LAST_ACCOUNT_KEY));

  await one.store.setAccount(null);
  check("signed out: the defaults, nothing of Ann's on screen", JSON.stringify(one.store.get()) === JSON.stringify(DEFAULT_SETTINGS));
  check("signed out: nothing about her is left in the browser", ![...shared.data.keys()].some((k) => k.includes("uid-ann")) && shared.getItem(LAST_ACCOUNT_KEY) === null);

  await one.store.setAccount("uid-bob");
  check("Bob signs in on the same browser: he gets the defaults, not Ann's wallpaper, level or memory switch", JSON.stringify(one.store.get()) === JSON.stringify(DEFAULT_SETTINGS));
  one.store.update({ wallpaper: { id: "ember" } });
  await one.store.flush();
  check("Bob's choice is his own", db.rows.get("uid-bob") !== undefined && (db.rows.get("uid-ann") as any).wallpaper.id === "aurora" && one.store.get().wallpaper.id === "ember" && one.store.get().reasoning === "medium");

  await one.store.setAccount("uid-ann");
  check("Ann signs back in: her own settings return from her account", one.store.get().wallpaper.id === "aurora" && one.store.get().reasoning === "fast" && one.store.get().memoryEnabled === false);
  check("and Bob's cache is gone from the browser", readCache(shared, "uid-bob") === null);

  section("Switching accounts without signing out");
  const direct = device(db);
  await direct.store.setAccount("uid-ann");
  await direct.store.setAccount("uid-bob");
  check("going straight from one account to another never shows the first one's settings", direct.store.get().wallpaper.id === "ember" && direct.store.get().reasoning === "medium");

  section("A new device: the settings follow the account");
  const phone = device(db);
  await phone.store.setAccount("uid-ann");
  check("a fresh browser, same Google account: the same wallpaper, level and memory switch", phone.store.get().wallpaper.id === "aurora" && phone.store.get().reasoning === "fast" && phone.store.get().memoryEnabled === false);
  const cached = readCache(phone.storage, "uid-ann");
  check("and it is cached for the next visit", cached?.settings.wallpaper.id === "aurora" && cached.dirty === false);
  const second = device(db, phone.storage);
  second.store.preload();
  check("the first paint of the next visit uses the cache of the account that was signed in", second.store.get().wallpaper.id === "aurora");
  await second.store.setAccount("uid-bob");
  check("and if a different account turns out to be signed in, that paint is replaced at once", second.store.get().wallpaper.id === "ember");

  section("Custom wallpaper");
  const pc = device(db);
  await pc.store.setAccount("uid-cy");
  pc.store.update({ wallpaper: { id: "custom", dataUrl: PNG } });
  await pc.store.flush();
  const laptop = device(db);
  await laptop.store.setAccount("uid-cy");
  check("an uploaded wallpaper is saved to the account and appears on another device", laptop.store.get().wallpaper.id === "custom" && laptop.store.get().wallpaper.dataUrl === PNG);
  pc.store.update({ wallpaper: { id: "custom", dataUrl: "javascript:alert(1)" } });
  check("a hostile wallpaper value is ignored, never stored", pc.store.get().wallpaper.dataUrl === PNG);
  db.rows.set("uid-evil", { wallpaper: { id: "custom", dataUrl: 'data:image/png;base64,AAAA");background:url(//evil' }, reasoning: "complex; drop", memory_enabled: "yes" });
  const evil = device(db);
  await evil.store.setAccount("uid-evil");
  check("a tampered database row is sanitised on the way in", evil.store.get().wallpaper.id === "tunnel" && evil.store.get().reasoning === "medium" && evil.store.get().memoryEnabled === true);

  section("Guests and signed-out visitors");
  const guestDb = new Database();
  const guest = device(guestDb);
  await guest.store.setAccount(null);
  guest.store.update({ wallpaper: aurora });
  check("a guest can look around: the change shows for this visit", guest.store.get().wallpaper.id === "aurora");
  check("but nothing is saved: no database write, nothing in the browser", guestDb.pushes.length === 0 && guest.storage.data.size === 0 && guest.timers.pending.size === 0);
  await guest.store.setAccount("uid-dee");
  check("and a guest's choices never become an account's", guest.store.get().wallpaper.id === "tunnel" && guestDb.rows.size === 0);

  section("Saving: batched, safe offline, never lost");
  const db2 = new Database();
  const d = device(db2);
  await d.store.setAccount("uid-eve");
  d.store.update({ reasoning: "fast" });
  d.store.update({ reasoning: "complex" });
  d.store.update({ memoryEnabled: false });
  check("several quick changes are saved in one write, after a short pause", db2.pushes.length === 0 && d.timers.pending.size === 1);
  d.timers.run();
  await new Promise((r) => setTimeout(r, 5));
  check("the write carries the latest of everything", db2.pushes.length === 1 && db2.pushes[0]!.settings.reasoning === "complex" && db2.pushes[0]!.settings.memoryEnabled === false);
  check("a change that did not change anything is not saved", (() => { const n = db2.pushes.length; d.store.update({ reasoning: "complex" }); return d.timers.pending.size === 0 && db2.pushes.length === n; })());

  db2.offline = true;
  d.store.update({ wallpaper: { id: "mint" } });
  await d.store.flush();
  check("offline: the change still shows and is kept, marked as not yet saved", d.store.get().wallpaper.id === "mint" && readCache(d.storage, "uid-eve")?.dirty === true);
  await d.store.setAccount(null);
  check("signing out offline keeps the unsaved change, but only under Eve's own id", readCache(d.storage, "uid-eve")?.settings.wallpaper.id === "mint" && d.store.get().wallpaper.id === "tunnel");
  await d.store.setAccount("uid-fay");
  check("another account never sees it", d.store.get().wallpaper.id === "tunnel" && readCache(d.storage, "uid-eve")?.dirty === true);
  db2.offline = false;
  await d.store.setAccount("uid-eve");
  check("when Eve is back online her unsaved change wins over the older copy and is saved", d.store.get().wallpaper.id === "mint" && (db2.rows.get("uid-eve") as any).wallpaper.id === "mint" && readCache(d.storage, "uid-eve")?.dirty === false);

  section("Races");
  const db3 = new Database();
  db3.rows.set("uid-gus", { wallpaper: { id: "mint" }, reasoning: "fast", memory_enabled: true });
  db3.rows.set("uid-hal", { wallpaper: { id: "paper" }, reasoning: "complex", memory_enabled: true });
  const racer = device(db3);
  let release!: () => void;
  db3.slow = new Promise<void>((r) => { release = r; });
  const loadingGus = racer.store.setAccount("uid-gus");
  const loadingHal = racer.store.setAccount("uid-hal");
  db3.slow = null;
  release();
  await Promise.all([loadingGus, loadingHal]);
  check("a slow answer for the previous account never overwrites the current one", racer.store.get().wallpaper.id === "paper" && racer.store.get().reasoning === "complex");
  const calm = device(db3);
  await calm.store.setAccount("uid-gus");
  calm.store.update({ reasoning: "medium" });
  await calm.store.setAccount("uid-hal");
  await new Promise((r) => setTimeout(r, 5));
  check("a pending save is dropped when the account changes, so it can never be written to the wrong account", (db3.rows.get("uid-hal") as any).reasoning === "complex" && calm.store.get().reasoning === "complex");

  section("Tidying the browser");
  const s = new Storage();
  s.setItem(cacheKey("a"), JSON.stringify({ settings: DEFAULT_SETTINGS, dirty: false }));
  s.setItem(cacheKey("b"), JSON.stringify({ settings: DEFAULT_SETTINGS, dirty: true }));
  s.setItem(cacheKey("c"), JSON.stringify({ settings: DEFAULT_SETTINGS, dirty: false }));
  s.setItem("unrelated", "keep");
  tidyStorage(s, "c");
  check("other accounts' synced caches go; unsaved ones, the current account and unrelated keys stay", s.getItem(cacheKey("a")) === null && s.getItem(cacheKey("b")) !== null && s.getItem(cacheKey("c")) !== null && s.getItem("unrelated") === "keep");
  check("a broken cache entry is ignored, not a crash", (() => { const t = new Storage(); t.setItem(cacheKey("x"), "{not json"); return readCache(t, "x") === null; })());

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("Failed:\n - " + failures.join("\n - ")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
