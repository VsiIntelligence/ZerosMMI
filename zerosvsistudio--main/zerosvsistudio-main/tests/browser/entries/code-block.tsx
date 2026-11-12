import { createRoot } from "react-dom/client";
import "@/design/tokens.css";
import "@/design/design.css";
import { CodeBlock } from "@/components/CodeBlock";
(window as unknown as { mountCode: () => void }).mountCode = () => createRoot(document.getElementById("root")!).render(<div style={{ maxWidth: 760, margin: "0 auto", padding: 16 }}>
  <CodeBlock language="javascript" code={"const answer = 6 * 7;\nconsole.log('the answer is', answer);"} />
  <CodeBlock language="html" code={"<h2 id=\"preview-title\">Preview works</h2><p>Rendered inside the sandbox.</p>"} />
  <CodeBlock language="python" code={"print('plain code, no runner')"} />
</div>);
