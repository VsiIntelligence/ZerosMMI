/**
 * Deterministic page content for the Zeros Web Kit. Used when the model cannot be reached, and as the quality floor the model's
 * pages are compared against. Copy is industry-aware but makes no invented factual claims (no fake clients, prices or statistics).
 */
import { ICONS } from "../video/kit";
import { slugify, type Brief, type PageSpec } from "./kit";

const ARROW = `<svg class="btn__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
type IconKey = keyof typeof ICONS;
const icon = (n: IconKey): string => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${ICONS[n]}"/></svg>`;

type Bank = { eyebrow: string; promises: { i: IconKey; t: string; d: string }[]; values: { i: IconKey; t: string; d: string }[]; steps: { t: string; d: string }[]; story: string; checks: string[]; faq: { q: string; a: string }[] };
const BANKS: { match: RegExp; bank: Bank }[] = [
  { match: /bak|cafe|coffee|food|restaurant|chef|pastr|kitchen|pizza|tea\b|catering|bar\b|brew/i, bank: {
    eyebrow: "Made fresh, served with care",
    promises: [{ i: "heart", t: "Made with care", d: "Every item starts with good ingredients and ends with someone paying attention." }, { i: "leaf", t: "Honest ingredients", d: "Simple, recognisable ingredients, prepared the way they should be." }, { i: "clock", t: "Fresh every day", d: "Prepared in small batches so what reaches you is at its best." }, { i: "coffee", t: "Made to share", d: "Food and drink are better with people. Come in, sit down, stay a while." }, { i: "gift", t: "Gifts and orders", d: "Planning an occasion? Tell us what you need and we will shape it with you." }, { i: "pin", t: "Easy to find", d: "Everything you need to visit or order is one tap away." }],
    values: [{ i: "heart", t: "Care first", d: "We would rather do fewer things well than many things quickly." }, { i: "leaf", t: "Honest craft", d: "Good food needs no tricks, just time, skill and respect for the ingredients." }, { i: "users", t: "Community", d: "We are part of the neighbourhood and we try to act like it." }],
    steps: [{ t: "Tell us what you need", d: "Browse, then get in touch about visits, orders or events." }, { t: "We prepare it", d: "Everything is made with attention and checked before it leaves." }, { t: "You enjoy it", d: "Share it, savour it, and tell us how it went." }],
    story: "It starts with a simple belief: people notice when something is made with care. That belief shapes how we choose ingredients, how we prepare them and how we welcome the people who come through the door.",
    checks: ["Simple, honest ingredients", "Small batches, made with attention", "A warm welcome, every time"],
    faq: [{ q: "How do I place an order?", a: "Use the contact page to tell us what you need and when. We will reply with the next steps." }, { q: "Do you cater for dietary needs?", a: "Tell us about any allergies or preferences when you get in touch and we will advise honestly on what we can do." }, { q: "Can I visit?", a: "Yes. Check the contact page for how to find us and when to come." }, { q: "Can you make something special?", a: "Often, yes. Describe the occasion and we will work out what is possible." }] } },
  { match: /tech|saas|software|app\b|ai\b|startup|code|dev|cloud|data|platform|digital|cyber/i, bank: {
    eyebrow: "Built for people who ship",
    promises: [{ i: "bolt", t: "Fast by default", d: "Performance is a feature. Everything is designed to feel instant." }, { i: "shield", t: "Secure and private", d: "Your data is treated with the care you would expect from a partner." }, { i: "layers", t: "Simple to start", d: "Get going in minutes with sensible defaults, then grow into the detail." }, { i: "sliders", t: "Made to fit", d: "Configure it around the way your team already works." }, { i: "chart", t: "Clear insight", d: "See what is happening at a glance, without drowning in dashboards." }, { i: "chat", t: "Real support", d: "Questions get answered by people who understand the product." }],
    values: [{ i: "target", t: "Clarity", d: "We remove everything that does not help you get the job done." }, { i: "shield", t: "Trust", d: "Reliable, secure and honest about what the product can and cannot do." }, { i: "rocket", t: "Momentum", d: "Small, steady improvements, shipped often." }],
    steps: [{ t: "Sign up", d: "Create an account and set up your workspace in a few minutes." }, { t: "Connect your work", d: "Bring in the tools and data you already use." }, { t: "Move faster", d: "Let the product handle the routine so you can focus on the hard parts." }],
    story: "We started with a frustration: good tools should make work calmer, not noisier. So we focus on the essentials, make them fast and reliable, and keep everything else out of the way.",
    checks: ["Fast, reliable and secure", "Sensible defaults, deep configuration", "Support from people who care"],
    faq: [{ q: "How do I get started?", a: "Head to the contact page and tell us about your team. We will help you set up." }, { q: "Is my data safe?", a: "Security and privacy are part of how we build. Ask us for the details that matter to you." }, { q: "Can it fit my workflow?", a: "It is designed to adapt. Tell us how you work and we will show you how it fits." }, { q: "What does support look like?", a: "You reach real people who know the product, through the contact page." }] } },
  { match: /health|yoga|wellness|spa|clinic|dental|care|therap|fitness|gym|coach|train|nutrition|medic/i, bank: {
    eyebrow: "Care that fits your life",
    promises: [{ i: "heart", t: "Personal care", d: "Plans shaped around you, not around a template." }, { i: "shield", t: "Safe and professional", d: "Thoughtful, qualified guidance, and honest about what is right for you." }, { i: "leaf", t: "Sustainable habits", d: "Small, realistic steps that you can keep going long after the first week." }, { i: "clock", t: "Flexible timing", d: "Support that works around your schedule." }, { i: "users", t: "A supportive space", d: "Welcoming, judgement-free and encouraging at every level." }, { i: "target", t: "Clear goals", d: "We agree what success looks like and check in along the way." }],
    values: [{ i: "heart", t: "Compassion", d: "We listen first, because the best plan starts with understanding you." }, { i: "shield", t: "Integrity", d: "Honest advice, even when it is not the easy answer." }, { i: "leaf", t: "Balance", d: "Wellbeing is built from many small, steady choices." }],
    steps: [{ t: "Say hello", d: "Tell us a little about where you are and what you want." }, { t: "Build your plan", d: "Together we shape a realistic approach that fits your life." }, { t: "Keep moving forward", d: "Regular check-ins keep it working as your needs change." }],
    story: "Good care begins with listening. We take the time to understand your situation, explain your options plainly and support you at a pace that feels right.",
    checks: ["Personal, judgement-free support", "Clear plans and honest advice", "Flexible around your life"],
    faq: [{ q: "How do I book?", a: "Use the contact page to tell us what you are looking for and we will arrange a first conversation." }, { q: "Is it suitable for beginners?", a: "Yes. We start where you are and build from there." }, { q: "What should I bring?", a: "Just yourself and any questions. We will explain anything else beforehand." }, { q: "Can I change my plan?", a: "Of course. Plans are meant to adapt as you do." }] } },
  { match: /./, bank: {
    eyebrow: "Done properly, start to finish",
    promises: [{ i: "target", t: "Clear from day one", d: "You always know what is happening, what comes next and why." }, { i: "check", t: "Quality you can see", d: "Careful work, checked before it reaches you." }, { i: "clock", t: "Respectful of your time", d: "Straightforward communication and dependable timing." }, { i: "users", t: "Made around people", d: "We design every detail with the person at the other end in mind." }, { i: "shield", t: "Honest and reliable", d: "We say what we can do, and then we do it." }, { i: "sparkle", t: "A little extra care", d: "The small details are where good becomes memorable." }],
    values: [{ i: "target", t: "Clarity", d: "Plain language, clear plans and no surprises." }, { i: "check", t: "Craft", d: "We care about getting the details right." }, { i: "heart", t: "Care", d: "We treat every project as if it were our own." }],
    steps: [{ t: "Talk it through", d: "Share what you need and what matters most." }, { t: "We shape the plan", d: "A clear proposal with the steps, the timing and the outcome." }, { t: "We deliver", d: "Careful execution, regular updates and a result you are proud of." }],
    story: "We believe good work comes from listening closely, planning carefully and paying attention to the details that others skip. That approach shapes everything we do.",
    checks: ["Clear plans and plain language", "Careful, checked work", "Reliable communication"],
    faq: [{ q: "How do we get started?", a: "Use the contact page to tell us what you need. We will reply with the next steps." }, { q: "How does the process work?", a: "We talk it through, agree a plan, then deliver with regular updates." }, { q: "Can you adapt to my needs?", a: "Yes. Tell us what matters most and we will shape the work around it." }, { q: "What if I have questions later?", a: "Just get in touch. We are happy to help." }] } },
];
const bankFor = (b: Brief): Bank => BANKS.find((x) => x.match.test(`${b.industry} ${b.name} ${b.description}`))!.bank;

/** Generative brand art as inline SVG: classes are styled by pages.css (tokens only), so it re-themes with the site. */
export function art(variant: number, label: string): string {
  const v = variant % 3;
  const shapes = v === 0
    ? `<circle class="art-a" cx="470" cy="150" r="130"/><circle class="art-ring" cx="470" cy="150" r="190"/><rect class="art-b" x="70" y="220" width="300" height="190" rx="28"/><rect class="art-line" x="104" y="262" width="150" height="14" rx="7"/><rect class="art-line" x="104" y="296" width="230" height="14" rx="7"/><rect class="art-line" x="104" y="330" width="190" height="14" rx="7"/><circle class="art-dot" cx="120" cy="96" r="14"/><circle class="art-dot" cx="164" cy="96" r="14"/>`
    : v === 1
      ? `<path class="art-a" d="M0 330 C120 250 220 410 340 330 C460 250 540 340 640 280 L640 480 L0 480 Z"/><path class="art-b" d="M0 390 C140 330 240 450 360 390 C480 330 560 400 640 360 L640 480 L0 480 Z"/><circle class="art-dot" cx="480" cy="120" r="58"/><circle class="art-ring" cx="480" cy="120" r="104"/><circle class="art-ring" cx="480" cy="120" r="150"/>`
      : `<rect class="art-b" x="60" y="60" width="240" height="240" rx="40" transform="rotate(-8 180 180)"/><rect class="art-a" x="250" y="150" width="260" height="260" rx="130"/><circle class="art-ring" cx="190" cy="360" r="90"/><rect class="art-line" x="330" y="86" width="190" height="14" rx="7"/><rect class="art-line" x="330" y="120" width="130" height="14" rx="7"/>`;
  return `<svg class="x-art" viewBox="0 0 640 480" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid slice"><rect class="art-bg" width="640" height="480"/>${shapes}</svg>`;
}

const card = (i: IconKey, t: string, d: string, delay = 0): string => `<article class="card card--hover spotlight tilt reveal${delay ? ` reveal-delay-${delay}` : ""}"><span class="card__icon">${icon(i)}</span><h3 class="card__title">${esc(t)}</h3><p class="card__text">${esc(d)}</p></article>`;
const faq = (items: { q: string; a: string }[]): string => `<div class="faq">${items.map((x) => `<details><summary>${esc(x.q)}</summary><p>${esc(x.a)}</p></details>`).join("")}</div>`;
const steps = (items: { t: string; d: string }[]): string => `<ol class="steps">${items.map((x, i) => `<li class="step reveal${i ? ` reveal-delay-${i}` : ""}"><h3>${esc(x.t)}</h3><p class="muted">${esc(x.d)}</p></li>`).join("")}</ol>`;
const cta = (b: Brief, title: string, text: string): string => `<section class="section"><div class="container"><div class="cta-band reveal"><h2 class="cta-band__title">${esc(title)}</h2><p>${esc(text)}</p><a class="btn btn--lg magnetic" href="${esc(b.cta.href)}">${esc(b.cta.label)}${ARROW}</a></div></div></section>`;
const head = (eyebrow: string, title: string, lead: string, center = true): string => `<div class="section__head${center ? " center" : ""}"><p class="eyebrow">${esc(eyebrow)}</p><h2 data-split="words">${esc(title)}</h2><p class="lead">${esc(lead)}</p></div>`;
const pageHero = (eyebrow: string, title: string, lead: string): string => `<section class="hero hero--center hero--mesh"><div class="hero__grid" aria-hidden="true"></div><div class="container"><p class="hero__eyebrow">${esc(eyebrow)}</p><h1 class="hero__title" data-split="words">${esc(title)}</h1><p class="hero__lead">${esc(lead)}</p></div></section>`;
const page = (p: PageSpec, b: Brief): PageSpec => p ?? b.pages[0]!;
void page;

export function homeMain(b: Brief): string {
  const k = bankFor(b), second = b.pages.find((p) => p.file !== "index.html" && !/contact|about/.test(p.file)) ?? b.pages[1]!;
  const bentoClass = ["bento__item--feature bento__item--tall", "bento__item--wide", "", "", "bento__item--wide", ""];
  const bento = k.promises.map((x, i) => `<article class="bento__item spotlight reveal${i % 3 ? ` reveal-delay-${i % 3}` : ""} ${bentoClass[i] ?? ""}"><span class="card__icon">${icon(x.i)}</span><h3 class="card__title">${esc(x.t)}</h3><p class="card__text">${esc(x.d)}</p></article>`).join("");
  return `<section class="hero hero--mesh">
  <div class="hero__grid" aria-hidden="true"></div>
  <div class="container split">
    <div class="stack stack--lg">
      <p class="hero__eyebrow">${esc(k.eyebrow)}</p>
      <h1 class="hero__title" data-split="words">${esc(b.tagline)}</h1>
      <p class="hero__lead">${esc(b.description)}</p>
      <div class="hero__actions"><a class="btn btn--primary btn--lg btn--glow magnetic" href="${esc(b.cta.href)}">${esc(b.cta.label)}${ARROW}</a><a class="btn btn--ghost btn--lg" href="${esc(second.file)}">${esc(second.nav)}</a></div>
    </div>
    <div class="hero__media media reveal reveal--scale">${art(0, `${b.name} brand illustration`)}</div>
  </div>
</section>
<section class="section section--tight" aria-label="What ${esc(b.name)} stands for">
  <div class="marquee"><div class="marquee__track">${k.promises.map((x) => `<span class="marquee__item">${esc(x.t)}</span>`).join("")}</div></div>
</section>
<section class="section section--alt" id="why">
  <div class="container">
    ${head("Why " + b.name, "Everything you would hope for, done properly", `A closer look at what makes ${b.name} different for ${b.audience}.`)}
    <div class="bento">${bento}</div>
  </div>
</section>
<section class="section" id="story">
  <div class="container split">
    <div class="media reveal">${art(1, `${b.name} story illustration`)}</div>
    <div class="stack stack--lg reveal">
      <p class="eyebrow">Our approach</p>
      <h2>${esc("The details are the whole point")}</h2>
      <p class="lead">${esc(k.story)}</p>
      <ul class="plan__list">${k.checks.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
      <p><a class="btn btn--ghost" href="${esc(b.pages.find((p) => /about/.test(p.file))?.file ?? "index.html")}">Read our story</a></p>
    </div>
  </div>
</section>
<section class="section section--alt" id="how">
  <div class="container">
    ${head("How it works", "Three simple steps", "No jargon and no surprises, just a clear path from first hello to a result you are happy with.")}
    ${steps(k.steps)}
  </div>
</section>
<section class="section" id="faq">
  <div class="container container--narrow">
    ${head("Questions", "Good things to know", `Quick answers about working with ${b.name}.`)}
    ${faq(k.faq)}
  </div>
</section>
${cta(b, `Ready when you are`, `Tell ${b.name} what you have in mind and we will take it from there.`)}`;
}

export function aboutMain(b: Brief): string {
  const k = bankFor(b);
  return `${pageHero("About " + b.name, `The people and principles behind ${b.name}`, b.description)}
<section class="section section--alt">
  <div class="container split">
    <div class="stack stack--lg reveal">
      <p class="eyebrow">Our story</p>
      <h2>Why we do what we do</h2>
      <p>${esc(k.story)}</p>
      <p class="muted">${esc(`${b.name} exists for ${b.audience}. Everything we make and every message we write is shaped by one question: would this help the person on the other side?`)}</p>
    </div>
    <div class="media reveal">${art(2, `${b.name} team illustration`)}</div>
  </div>
</section>
<section class="section" id="values">
  <div class="container">
    ${head("What we stand for", "Our values", "The principles we come back to whenever a decision gets difficult.")}
    <div class="features">${k.values.map((x, i) => card(x.i, x.t, x.d, i)).join("")}</div>
  </div>
</section>
<section class="section section--alt" id="process">
  <div class="container">
    ${head("How we work", "A clear, steady process", "You will always know where things stand and what happens next.")}
    ${steps(k.steps)}
  </div>
</section>
${cta(b, "Let's talk", `We would love to hear what you are working on.`)}`;
}

export function featuresMain(b: Brief, p: PageSpec): string {
  const k = bankFor(b);
  return `${pageHero(p.title, `${p.title} at ${b.name}`, p.purpose || b.description)}
<section class="section">
  <div class="container">
    ${head("What you get", "Everything in one place", `Here is what ${b.name} offers, explained plainly.`)}
    <div class="features">${k.promises.map((x, i) => card(x.i, x.t, x.d, i % 3)).join("")}</div>
  </div>
</section>
<section class="section section--alt" id="process">
  <div class="container">
    ${head("The process", "From first conversation to finished", "A simple path with clear checkpoints.")}
    ${steps(k.steps)}
  </div>
</section>
<section class="section" id="faq">
  <div class="container container--narrow">
    ${head("Questions", "Before you ask", `The questions we hear most about ${p.title.toLowerCase()}.`)}
    ${faq(k.faq)}
  </div>
</section>
${cta(b, "Find the right fit", `Not sure what you need? Tell ${b.name} about it and we will point you in the right direction.`)}`;
}

export function genericMain(b: Brief, p: PageSpec): string {
  const k = bankFor(b);
  return `${pageHero(p.title, p.title, p.purpose || p.description)}
<section class="section section--alt">
  <div class="container">
    ${head(p.title, `More about ${p.title.toLowerCase()}`, p.description || b.description)}
    <div class="features">${k.promises.slice(0, 3).map((x, i) => card(x.i, x.t, x.d, i)).join("")}</div>
  </div>
</section>
<section class="section" id="faq">
  <div class="container container--narrow">${head("Questions", "Good things to know", `Quick answers about ${p.title.toLowerCase()}.`)}${faq(k.faq.slice(0, 3))}</div>
</section>
${cta(b, "Take the next step", `Get in touch with ${b.name} and we will help you get started.`)}`;
}

export function contactMain(b: Brief): string {
  const k = bankFor(b);
  const info = [b.contact.email && `<article class="card"><span class="card__icon">${icon("mail")}</span><h3 class="card__title">Email</h3><p class="card__text"><a href="mailto:${esc(b.contact.email)}">${esc(b.contact.email)}</a></p></article>`, b.contact.phone && `<article class="card"><span class="card__icon">${icon("phone")}</span><h3 class="card__title">Phone</h3><p class="card__text"><a href="tel:${esc(b.contact.phone.replace(/[^+\d]/g, ""))}">${esc(b.contact.phone)}</a></p></article>`, b.contact.address && `<article class="card"><span class="card__icon">${icon("pin")}</span><h3 class="card__title">Find us</h3><p class="card__text">${esc(b.contact.address)}</p></article>`].filter(Boolean).join("");
  return `${pageHero("Contact", `Say hello to ${b.name}`, `Tell us a little about what you need and we will reply with clear next steps.`)}
<section class="section section--alt">
  <div class="container split">
    <form class="form reveal" data-validate novalidate aria-label="Contact form">
      <div class="field"><label class="field__label" for="name">Your name</label><input class="input" id="name" name="name" type="text" autocomplete="name" required minlength="2"><span class="field__error" aria-live="polite"></span></div>
      <div class="field"><label class="field__label" for="email">Email address</label><input class="input" id="email" name="email" type="email" autocomplete="email" required><span class="field__error" aria-live="polite"></span></div>
      <div class="field"><label class="field__label" for="topic">What is this about?</label><select class="select" id="topic" name="topic"><option>A general question</option><option>A new project or order</option><option>Support</option></select></div>
      <div class="field"><label class="field__label" for="message">Message</label><textarea class="textarea" id="message" name="message" required minlength="10"></textarea><span class="field__hint">A few sentences is plenty.</span><span class="field__error" aria-live="polite"></span></div>
      <button class="btn btn--primary btn--lg" type="submit">Send message</button>
      <p class="form__status" role="status" tabindex="-1" hidden>Thank you. This is a demo form with no server behind it yet, so nothing was sent; see the README to connect it.</p>
    </form>
    <div class="stack stack--lg reveal">
      <p class="eyebrow">Other ways to reach us</p>
      <h2>We read every message</h2>
      <p class="lead">${esc(`Whether it is a quick question or a big idea, ${b.name} is happy to help. Share as much or as little as you like.`)}</p>
      ${info ? `<div class="grid">${info}</div>` : `<p class="muted">Use the form and we will get back to you.</p>`}
    </div>
  </div>
</section>
<section class="section" id="faq">
  <div class="container container--narrow">${head("Questions", "Before you write", `A few things people often ask ${b.name}.`)}${faq(k.faq.slice(0, 3))}</div>
</section>`;
}

/** Every page of the brief as `<main>` content. The page prompt for the model asks for exactly this shape. */
export function fallbackMains(b: Brief): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of b.pages) out[p.file] = p.file === "index.html" ? homeMain(b) : /about/.test(p.file) ? aboutMain(b) : /contact/.test(p.file) ? contactMain(b) : /feature|service|menu|work|product|offer|program|class|solution/.test(p.file) ? featuresMain(b, p) : genericMain(b, p);
  return out;
}

export function defaultPagesCss(b: Brief): string {
  return `/* Page-specific styles. Classes here start with x- and are built from the design tokens in tokens.css. */
.x-art { width: 100%; height: 100%; display: block; }
.x-art .art-bg { fill: color-mix(in srgb, var(--color-primary) 10%, var(--color-surface)); }
.x-art .art-a { fill: var(--color-primary); opacity: 0.9; }
.x-art .art-b { fill: var(--color-accent); opacity: 0.85; }
.x-art .art-dot { fill: var(--color-text); opacity: 0.85; }
.x-art .art-line { fill: var(--color-surface); opacity: 0.9; }
.x-art .art-ring { fill: none; stroke: var(--color-primary); stroke-width: 2; opacity: 0.4; }
.x-art .art-a, .x-art .art-dot { animation: float 9s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
.x-art .art-b { animation: float 11s ease-in-out infinite reverse; transform-box: fill-box; transform-origin: center; }
.hero .split { align-items: center; }
.hero__media { transform: rotate(1.2deg); }
@media (max-width: 52rem) { .hero__media { transform: none; } }
`;
}
export const _slug = slugify;
