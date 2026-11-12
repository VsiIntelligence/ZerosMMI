import { useState } from "react";
import { Plug } from "lucide-react";
import type { AppProposal } from "@/lib/chat-attachments";
import { runAppAction } from "@/lib/apps-client";

/** Shows which apps a reply read from, so the answer's source is always visible. */
export function AppChips({ apps }: { apps: string[] }) {
  if (!apps.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]" aria-label="Apps used for this reply">
      {apps.map((app) => (
        <span key={app} className="inline-flex items-center gap-1 rounded-full border border-border bg-card/60 px-2 py-0.5 text-muted-foreground">
          <Plug className="h-3 w-3" aria-hidden="true" /> Used {app}
        </span>
      ))}
    </div>
  );
}

/** A change Zeros proposes. Nothing changes until the person presses Confirm. */
export function ActionProposalCard({ proposal }: { proposal: AppProposal }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "cancelled" | "error">("idle");
  const [text, setText] = useState("");
  const run = async () => {
    setState("running");
    const result = await runAppAction(proposal, true);
    if (result.ok) { setState("done"); setText(result.data.text); }
    else { setState("error"); setText(result.error); }
  };
  return (
    <div className="mt-3 rounded-xl border border-amber-400/40 bg-amber-500/5 p-3 text-sm" role="group" aria-label="Action waiting for your confirmation">
      <p className="font-semibold">Ready to act: {proposal.summary}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">App: {proposal.toolkit} · action: {proposal.tool}</p>
      {state === "idle" && (
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={run} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground">Confirm and run</button>
          <button type="button" onClick={() => setState("cancelled")} className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold">Cancel</button>
        </div>
      )}
      {state === "running" && <p className="mt-2 text-xs text-muted-foreground">Running…</p>}
      {state === "done" && <p className="mt-2 text-xs text-emerald-400">Done. {text.slice(0, 400)}</p>}
      {state === "error" && <p role="alert" className="mt-2 text-xs text-red-400">{text}</p>}
      {state === "cancelled" && <p className="mt-2 text-xs text-muted-foreground">Cancelled. Nothing was changed.</p>}
    </div>
  );
}
