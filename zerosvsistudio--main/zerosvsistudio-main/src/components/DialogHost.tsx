import { useState, type FormEvent } from "react";
import { Sheet } from "@/components/zx";
import { settleDialog, useDialogs, type ConfirmRequest, type PromptRequest } from "@/lib/dialogs";

function ConfirmView({ req }: { req: ConfirmRequest }) {
  const done = (ok: boolean) => { req.resolve(ok); settleDialog(req.id); };
  return (
    <Sheet label={req.title} size="sm" centered onClose={() => done(false)}>
      <div className="zx-dialog">
        <h2>{req.title}</h2>
        {req.message ? <p>{req.message}</p> : null}
        <div className="zx-sheet__foot">
          <button type="button" className="zx-btn zx-btn--secondary" {...(req.destructive ? { "data-autofocus": "" } : {})} onClick={() => done(false)}>{req.cancelLabel}</button>
          <button type="button" className={`zx-btn ${req.destructive ? "zx-btn--solid-danger" : "zx-btn--primary"}`} {...(req.destructive ? {} : { "data-autofocus": "" })} onClick={() => done(true)}>{req.confirmLabel}</button>
        </div>
      </div>
    </Sheet>
  );
}

function PromptView({ req }: { req: PromptRequest }) {
  const [value, setValue] = useState(req.initial);
  const done = (v: string | null) => { req.resolve(v); settleDialog(req.id); };
  const submit = (e: FormEvent) => { e.preventDefault(); const v = value.trim(); if (v) done(v); };
  return (
    <Sheet label={req.title} size="sm" centered onClose={() => done(null)}>
      <form className="zx-dialog" onSubmit={submit}>
        <h2>{req.title}</h2>
        {req.message ? <p>{req.message}</p> : null}
        <input className="zx-field" data-autofocus value={value} maxLength={req.maxLength} placeholder={req.placeholder} aria-label={req.title} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        <div className="zx-sheet__foot">
          <button type="button" className="zx-btn zx-btn--secondary" onClick={() => done(null)}>Cancel</button>
          <button type="submit" className="zx-btn zx-btn--primary" disabled={!value.trim()}>{req.confirmLabel}</button>
        </div>
      </form>
    </Sheet>
  );
}

/** Shows the confirm and ask-for-text dialogs, one at a time. Mounted once on the chat page. */
export default function DialogHost() {
  const current = useDialogs()[0];
  if (!current) return null;
  return current.kind === "confirm" ? <ConfirmView key={current.id} req={current} /> : <PromptView key={current.id} req={current} />;
}
