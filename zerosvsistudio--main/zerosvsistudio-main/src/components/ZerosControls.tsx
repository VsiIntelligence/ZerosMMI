import { useEffect } from "react";
import { Zap, Gauge, Brain } from "lucide-react";
import { hasAccess, useBillingStatus } from "@/lib/billing-client";
import { useAccountSettings } from "@/lib/account-settings";
import { setReasoningLevel } from "@/lib/reasoning-settings";
import type { ReasoningLevelName } from "@/lib/zeros";

const LEVELS: { id: ReasoningLevelName; label: string; hint: string; Icon: typeof Zap }[] = [
  { id: "fast", label: "Fast", hint: "As fast as possible: the fastest model answers first", Icon: Zap },
  { id: "medium", label: "Medium", hint: "A balance of speed and intelligence", Icon: Gauge },
  { id: "complex", label: "Complex", hint: "Best quality: planning and review on every answer (Gold)", Icon: Brain },
];

/** The reasoning level and today's usage, above the composer. Apps and wallpapers live in Settings. */
export default function ZerosControls() {
  const { status } = useBillingStatus();
  const { reasoning: level } = useAccountSettings();
  /* a saved Complex level that this account no longer has (a lapsed Gold, a switch to Bronze) falls back to Medium */
  const complexAllowed = !!status?.complexAllowed;
  useEffect(() => {
    if (status && !complexAllowed && level === "complex") setReasoningLevel("medium");
  }, [status, complexAllowed, level]);
  if (!hasAccess(status) || !status) return null;
  const resets = status.resetsAt ? new Date(status.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap items-center gap-2 px-1 text-xs" role="group" aria-label="Reasoning">
      <div className="inline-flex rounded-full border border-border bg-card/60 p-0.5" role="radiogroup" aria-label="Reasoning level">
        {LEVELS.map(({ id, label, hint, Icon }) => {
          const locked = id === "complex" && !status.complexAllowed;
          return (
            <button key={id} type="button" role="radio" aria-checked={level === id} title={locked ? "Complex reasoning is a Gold feature" : hint} disabled={locked} onClick={() => setReasoningLevel(id)}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-semibold transition ${level === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"} disabled:opacity-40`}>
              <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {label}{locked ? " 🔒" : ""}
            </button>
          );
        })}
      </div>
      <span className="rounded-full border border-border bg-card/60 px-2.5 py-1 text-muted-foreground" aria-live="polite">
        {status.unlimited ? "Unlimited" : `${status.planLabel} · ${Math.floor(status.remainingRequests)} of ${status.dailyRequests} left${resets ? ` · resets ${resets}` : ""}`}
      </span>
    </div>
  );
}
