import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Palette, Plug, Settings, User, X } from "lucide-react";
import AccountPanel from "@/components/settings/AccountPanel";
import AppearancePanel from "@/components/settings/AppearancePanel";
import AppsPanel from "@/components/settings/AppsPanel";
import { Sheet } from "@/components/zx";
import { OPEN_SETTINGS_EVENT, type SettingsTab } from "@/lib/settings-events";

const TABS: { id: SettingsTab; label: string; Icon: typeof User }[] = [
  { id: "account", label: "Account", Icon: User },
  { id: "apps", label: "Apps", Icon: Plug },
  { id: "appearance", label: "Appearance", Icon: Palette },
];

function SettingsSheet({ initial, isGuest, onClose }: { initial: SettingsTab; isGuest: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>(initial);
  useEffect(() => setTab(initial), [initial]);
  /** Arrow keys, Home and End move between the tabs, the way a native settings window does. */
  const onNavKey = (e: KeyboardEvent<HTMLElement>) => {
    const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const at = TABS.findIndex((t) => t.id === tab);
    const next = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : (at + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    const target = TABS[next];
    if (!target) return;
    setTab(target.id);
    document.getElementById(`settings-tab-${target.id}`)?.focus();
  };
  const panel: ReactNode = tab === "account" ? <AccountPanel isGuest={isGuest} onClose={onClose} /> : tab === "apps" ? <AppsPanel /> : <AppearancePanel />;
  return (
    <Sheet label="Settings" size="lg" onClose={onClose}>
      <div className="zx-settings">
        <nav className="zx-settings__nav" role="tablist" aria-label="Settings sections" aria-orientation="vertical" onKeyDown={onNavKey}>
          <div className="zx-settings__brand">Settings</div>
          {TABS.map(({ id, label, Icon }) => (
            <button key={id} type="button" role="tab" id={`settings-tab-${id}`} aria-selected={tab === id} aria-controls="settings-panel" tabIndex={tab === id ? 0 : -1} className="zx-navitem" onClick={() => setTab(id)}>
              <Icon aria-hidden="true" /> {label}
            </button>
          ))}
        </nav>
        <div className="zx-settings__main">
          <div className="zx-settings__bar">
            <span />
            <button type="button" className="zx-icon-btn" aria-label="Close settings" onClick={onClose}><X /></button>
          </div>
          <div className="zx-settings__scroll" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>{panel}</div>
        </div>
      </div>
    </Sheet>
  );
}

/** The settings button, always visible (the original floating gear). It opens Account and Appearance. */
export default function SettingsButton({ isGuest = false }: { isGuest?: boolean }) {
  const [tab, setTab] = useState<SettingsTab | null>(null);
  useEffect(() => {
    const open = (e: Event) => {
      const wanted = (e as CustomEvent<{ tab?: SettingsTab }>).detail?.tab;
      setTab(wanted === "appearance" || wanted === "apps" ? wanted : "account");
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, open);
  }, []);
  return (
    <>
      <button type="button" onClick={() => setTab("account")} aria-label="Settings" className="fixed right-3 top-3 z-40 inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background/80 text-muted-foreground backdrop-blur hover:text-foreground">
        <Settings className="h-4 w-4" aria-hidden="true" />
      </button>
      {tab ? <SettingsSheet initial={tab} isGuest={isGuest} onClose={() => setTab(null)} /> : null}
    </>
  );
}
