/**
 * Code in replies: which blocks can run, what the preview document contains, how a markdown code block is read, and that the runner's
 * worker refuses the network. The behaviour in a real browser (output, time limits, isolation) is checked in the browser harness.
 */
import { runnableLanguage, htmlDocument, codeFromPre, SANDBOX_WORKER_SOURCE } from "../src/lib/code-run.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  [${detail.slice(0, 240)}]` : ""}`); };
const section = (s: string) => console.log(`\n== ${s}`);

section("Which blocks can run or preview");
check("js, javascript and mjs can run", ["js", "javascript", "JS", " mjs "].every((l) => runnableLanguage(l) === "javascript"));
check("html and htm can preview", ["html", "HTM"].every((l) => runnableLanguage(l) === "html"));
check("other languages are shown as code only (no Python, shell or TypeScript runner yet)", ["python", "bash", "ts", "tsx", "", "json"].every((l) => runnableLanguage(l) === null));

section("The HTML preview document");
const doc = htmlDocument("<h1>Hello</h1><script>document.body.dataset.ran = 'yes'</script>");
check("it carries a policy that allows scripts and styles but no network", /Content-Security-Policy/.test(doc) && /default-src 'none'/.test(doc) && !/connect-src|https?:\/\//.test(doc.match(/Content-Security-Policy[^>]*/)?.[0] ?? "x"));
check("a full page keeps its own head and gets the policy inside it", /<head[^>]*><meta http-equiv="Content-Security-Policy"/.test(htmlDocument("<!doctype html><html><head><title>x</title></head><body>y</body></html>")));
check("a fragment is wrapped into a page", /^<!doctype html>/.test(htmlDocument("<p>just a fragment</p>")) && /<body><p>just a fragment<\/p><\/body>/.test(htmlDocument("<p>just a fragment</p>")));
check("the code itself is not altered", /<script>document\.body\.dataset\.ran = 'yes'<\/script>/.test(doc));

section("Reading a markdown code block");
const block = { type: "element", tagName: "pre", children: [{ type: "element", tagName: "code", properties: { className: ["language-javascript"] }, children: [{ type: "text", value: "console.log(1)\n" }, { type: "text", value: "console.log(2)" }] }] };
check("the language and the code are read, without the trailing newline", JSON.stringify(codeFromPre(block)) === JSON.stringify({ language: "javascript", code: "console.log(1)\nconsole.log(2)" }), JSON.stringify(codeFromPre(block)));
check("a block with no language gives an empty language", codeFromPre({ children: [{ tagName: "code", properties: { className: [] }, children: [{ value: "x" }] }] })?.language === "");
check("something that is not a code block gives nothing", codeFromPre({ children: [{ tagName: "p" }] }) === null && codeFromPre(undefined) === null);

section("The runner's worker refuses the network and cannot reach the page");
check("fetch is refused", /self\.fetch = refused/.test(SANDBOX_WORKER_SOURCE));
check("XMLHttpRequest, WebSocket and EventSource are removed", /XMLHttpRequest = undefined/.test(SANDBOX_WORKER_SOURCE) && /WebSocket = undefined/.test(SANDBOX_WORKER_SOURCE) && /EventSource = undefined/.test(SANDBOX_WORKER_SOURCE));
check("importScripts is refused (no loading code from elsewhere)", /self\.importScripts = refused/.test(SANDBOX_WORKER_SOURCE));
check("output goes back to Zeros only through the tagged message channel", /source: "zeros-run"/.test(SANDBOX_WORKER_SOURCE));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
