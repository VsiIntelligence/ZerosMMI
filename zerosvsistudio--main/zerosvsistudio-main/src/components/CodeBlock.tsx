import { useState, type ReactNode } from "react";
import { codeFromPre, htmlDocument, runJavascript, runnableLanguage, type RunOutcome } from "@/lib/code-run";

/** A code block in a reply: copy it, run it (JavaScript) or preview it (HTML). Runs happen in a sandbox, see lib/code-run. */
export function CodeBlock({ language, code }: { language: string; code: string }) {
  const kind = runnableLanguage(language);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState(false);
  const [copied, setCopied] = useState(false);

  const run = async (): Promise<void> => {
    setRunning(true);
    setOutcome(null);
    setOutcome(await runJavascript(code));
    setRunning(false);
  };
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="zx-code">
      <div className="zx-code__bar">
        <span>{language || "code"}</span>
        <span className="zx-code__actions">
          <button type="button" className="zx-btn zx-btn--secondary zx-btn--sm" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
          {kind === "javascript" ? (
            <button type="button" className="zx-btn zx-btn--secondary zx-btn--sm" disabled={running} onClick={() => void run()}>{running ? "Running…" : "Run"}</button>
          ) : null}
          {kind === "html" ? (
            <button type="button" className="zx-btn zx-btn--secondary zx-btn--sm" onClick={() => setPreview((on) => !on)}>{preview ? "Show code" : "Preview"}</button>
          ) : null}
        </span>
      </div>
      {kind === "html" && preview ? (
        <iframe title="HTML preview" sandbox="allow-scripts" srcDoc={htmlDocument(code)} className="zx-code__frame" />
      ) : (
        <pre className="zx-code__pre"><code>{code}</code></pre>
      )}
      {outcome ? (
        <div className="zx-code__out" role="status" aria-live="polite">
          {outcome.logs.map((line, i) => <div key={i} className={`zx-code__line zx-code__line--${line.level}`}>{line.text}</div>)}
          {outcome.errors.map((text, i) => <div key={`e${i}`} className="zx-code__line zx-code__line--error">{text}</div>)}
          {outcome.timedOut ? <div className="zx-code__line zx-code__line--error">Stopped: it ran past the time limit.</div> : null}
          {!outcome.logs.length && !outcome.errors.length && !outcome.timedOut ? <div className="zx-code__line">Finished with no output.</div> : null}
          <div className="zx-code__time">{outcome.ms} ms</div>
        </div>
      ) : null}
    </div>
  );
}

/** Replaces the plain markdown code block with one that can be copied, run or previewed. */
export function MarkdownPre({ node, children }: { node?: unknown; children?: ReactNode }) {
  const parsed = codeFromPre(node);
  if (!parsed) return <pre>{children}</pre>;
  return <CodeBlock language={parsed.language} code={parsed.code} />;
}
