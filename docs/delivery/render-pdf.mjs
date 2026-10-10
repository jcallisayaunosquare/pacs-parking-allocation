/**
 * Markdown -> HTML (mermaid rendered to inline SVG) -> PDF.
 *
 * Two stages in one script:
 *   1. `marked` turns the document into HTML, leaving each ```mermaid block as a
 *      <pre class="mermaid"> element.
 *   2. Chromium (the browser Playwright already has on this machine) loads that page,
 *      mermaid's own bundle replaces every block with an SVG, and the page is printed.
 *
 * Mermaid is loaded from the local node_modules rather than a CDN, so the render does
 * not depend on the network at print time and the diagram in the PDF is the one this
 * version of mermaid draws.
 *
 * Usage: node render.mjs <in.md> <out.pdf> [out.html]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { marked } from 'marked';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const mermaidJs = await readFile(require.resolve('mermaid/dist/mermaid.min.js'), 'utf8');

const [, , input, outputPdf, outputHtml] = process.argv;
if (!input || !outputPdf) {
  console.error('usage: node render.mjs <in.md> <out.pdf> [out.html]');
  process.exit(2);
}

// A BOM would stop `marked` recognising the first heading, and it is exactly the defect
// this repository's pre-commit hook exists to refuse. Strip it rather than render it.
const source = (await readFile(input, 'utf8')).replace(/^﻿/, '');

/*
 * Mermaid blocks are pulled out before `marked` sees them and put back afterwards.
 * Letting marked render them produces an HTML-escaped <code> element, and mermaid then
 * parses `--&gt;` as part of a node label instead of an arrow.
 */
/*
 * A diagram may be marked with an HTML comment on the line before its fence:
 *
 *   <!-- figure:wide -->   its own landscape page, for a diagram wider than it is tall
 *   <!-- figure:page -->   its own portrait page with narrow margins
 *
 * Without one it flows with the prose and is scaled to the text measure. The comment is
 * invisible in every other Markdown renderer, so the source stays portable.
 */
const diagrams = [];
const withPlaceholders = source.replace(
  /(?:<!--\s*figure:(wide|page)\s*-->\s*\r?\n)?```mermaid\r?\n([\s\S]*?)```/g,
  (_m, mode, body) => {
    diagrams.push({ body, mode: mode ?? null });
    return `\n\nMERMAIDPLACEHOLDER${diagrams.length - 1}ENDPLACEHOLDER\n\n`;
  },
);

marked.setOptions({ gfm: true, breaks: false });
let body = await marked.parse(withPlaceholders);

body = body.replace(/<p>MERMAIDPLACEHOLDER(\d+)ENDPLACEHOLDER<\/p>/g, (_m, i) => {
  const { body: src, mode } = diagrams[Number(i)];
  const text = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const figure = `<pre class="mermaid">${text}</pre>`;
  if (!mode) return figure;
  return `<div class="figure figure--${mode}">${figure}</div>`;
});

/*
 * A figure that gets its own page takes its heading with it.
 *
 * The heading says `break-after: avoid` and the figure said `break-before: page`, and a
 * forced break beats an avoidance every time: the heading was left behind as the last
 * line of the previous page - often the only line on it - and the diagram began the next.
 * Moving the heading inside the container means the break happens before the pair rather
 * than between them, and the caption that follows comes too, so a figure page reads as
 * one thing.
 */
body = body.replace(
  /(<h([2-4])[^>]*>[\s\S]*?<\/h\2>)\s*(<div class="figure figure--(?:wide|page)">[\s\S]*?<\/div>)/g,
  (_m, heading, _level, container) =>
    container.replace(/^(<div class="figure[^"]*">)/, (open) => open + heading),
);

const title = (source.match(/^#\s+(.+)$/m) ?? [, path.basename(input)])[1];

/*
 * The icon pack, cut down to the icons this document actually names.
 *
 * The whole `logos` collection is 7 MB of JSON. Inlining it works and makes every render
 * slower for nothing, so this takes the `logos:name` references out of the source and
 * ships those. An absent icon is reported here rather than drawn as an empty box, which
 * is what mermaid does with one it cannot resolve.
 */
const iconPackJson = await (async () => {
  const wanted = [...new Set([...source.matchAll(/logos:([a-z0-9-]+)/g)].map((m) => m[1]))];
  if (wanted.length === 0) return 'null';
  let pack;
  try {
    pack = JSON.parse(await readFile(require.resolve('@iconify-json/logos/icons.json'), 'utf8'));
  } catch {
    console.error('this document uses logos: icons but @iconify-json/logos is not installed');
    process.exit(1);
  }
  const icons = {};
  const missing = [];
  for (const name of wanted) {
    if (pack.icons[name]) icons[name] = pack.icons[name];
    else missing.push(name);
  }
  if (missing.length > 0) {
    console.error(`no such icon in the logos pack: ${missing.join(', ')}`);
    process.exit(1);
  }
  return JSON.stringify({ ...pack, icons });
})();

const html = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm; }
  /* A figure too large for the text measure gets a page of its own and narrow margins.
     Landscape when it is wider than it is tall; portrait when it is not.

     Rotating the wide ones onto portrait pages instead was tried, to be rid of the mixed
     page sizes: a transform does not affect layout, the reserved box did not hold, and
     the prose printed over the figures. Measured, not guessed - the document collapsed
     from 55 pages to 18 with twice the marks on each. Reverted. */
  @page wide { size: A4 landscape; margin: 12mm 12mm 14mm; }
  @page tall { size: A4; margin: 12mm 12mm 14mm; }
  :root {
    --ink: #16181c;
    --ink-2: #3c424d;
    --ink-3: #697186;
    --rule: #d7dbe3;
    --rule-soft: #e9ecf1;
    --surface: #f6f7f9;
    --accent: #1f4e79;
  }
  * { box-sizing: border-box; }
  body {
    font-family: "Charter", "Georgia", "Times New Roman", serif;
    font-size: 10.2pt;
    line-height: 1.52;
    color: var(--ink);
    margin: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1, h2, h3, h4 {
    font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    line-height: 1.25;
    color: var(--ink);
    margin: 1.6em 0 0.5em;
  }
  h1 {
    font-size: 21pt;
    letter-spacing: -0.012em;
    margin: 0 0 0.2em;
    padding-bottom: 0.35em;
    border-bottom: 2px solid var(--accent);
  }
  h2 {
    font-size: 14.5pt;
    margin-top: 1.9em;
    padding-bottom: 0.22em;
    border-bottom: 1px solid var(--rule);
    break-after: avoid;
  }
  h3 { font-size: 11.6pt; break-after: avoid; }
  h4 { font-size: 10.4pt; color: var(--ink-2); break-after: avoid; }
  p, li { orphans: 2; widows: 2; }
  a { color: var(--accent); text-decoration: none; }
  code, pre, kbd {
    font-family: "Cascadia Mono", "Consolas", "DejaVu Sans Mono", monospace;
  }
  code { font-size: 0.88em; background: var(--surface); padding: 0.04em 0.16em; border-radius: 2px; }
  pre {
    background: var(--surface);
    border: 1px solid var(--rule-soft);
    border-left: 3px solid var(--accent);
    padding: 0.7em 0.9em;
    font-size: 8.5pt;
    line-height: 1.45;
    overflow-wrap: break-word;
    white-space: pre-wrap;
    break-inside: avoid;
  }
  pre code { background: none; padding: 0; font-size: inherit; }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 8.8pt;
    margin: 0.9em 0;
    break-inside: avoid;
  }
  th, td { border: 1px solid var(--rule); padding: 0.34em 0.5em; text-align: left; vertical-align: top; }
  th { background: var(--surface); font-family: "Segoe UI", Arial, sans-serif; font-size: 8.4pt; }
  blockquote {
    margin: 1em 0;
    padding: 0.1em 0 0.1em 0.9em;
    border-left: 3px solid var(--rule);
    color: var(--ink-2);
  }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 1.8em 0; }
  /* A diagram is a figure: it never splits across a page, and it is centred. */
  pre.mermaid {
    background: none;
    border: 0;
    padding: 0.4em 0;
    margin: 1.1em 0 1.3em;
    text-align: center;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  pre.mermaid svg { max-width: 100%; height: auto; }

  /* A full-page figure. The height cap is what stops a tall diagram overflowing the
     page it was given: without it the SVG keeps its aspect ratio against the width
     alone and the bottom simply disappears. */
  /* break-after is deliberately absent. It forced whatever followed onto a page of its
     own, which with two figures in a row produced a page holding nothing but white. The
     break before is enough: the figure starts a page, and the prose after it fills the
     rest rather than waiting for the next one. */
  /* A figure is kept whole and, when it has a page of its own, takes its heading with
     it: the heading is moved inside this container, so the forced break happens before
     the pair instead of between them. A title stranded at the foot of the previous page
     was the symptom. */
  .figure {
    break-before: page;
    break-inside: avoid;
  }
  .figure pre.mermaid { margin: 0; }
  .figure > h2,
  .figure > h3,
  .figure > h4 {
    margin-top: 0;
    margin-bottom: 0.5em;
  }
  .figure--wide { page: wide; }
  /* Room for the heading, which was not on these pages when the caps were chosen. */
  .figure--wide pre.mermaid svg { max-height: 168mm; }
  .figure--page { page: tall; }
  .figure--page pre.mermaid svg { max-height: 252mm; }
</style>
</head>
<body>
${body}
<script>${mermaidJs}</script>
<script>window.__iconPack = ${iconPackJson};</script>
<script>
  window.__mermaidDone = false;
  window.__mermaidError = null;
  /*
   * The service logos. Registered before initialize, because mermaid resolves an icon
   * shape while it parses and an icon registered late renders as an empty box with no
   * error - which is worse than a missing figure, since it ships looking deliberate.
   */
  if (window.__iconPack && mermaid.registerIconPacks) {
    mermaid.registerIconPacks([{ name: 'logos', icons: window.__iconPack }]);
  }
  mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    securityLevel: 'loose',
    fontFamily: 'Segoe UI, Helvetica Neue, Arial, sans-serif',
    flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
    sequence: {
      useMaxWidth: true,
      mirrorActors: false,
      wrap: true,
      actorFontSize: 12,
      messageFontSize: 11,
      noteFontSize: 11,
      boxTextMargin: 4,
      actorMargin: 34,
      width: 140
    },
    er: { useMaxWidth: true, fontSize: 11 },
    state: { useMaxWidth: true },
    themeVariables: { fontSize: '13px', primaryColor: '#eef2f7', lineColor: '#5a6477' }
  });
  mermaid
    .run({ querySelector: 'pre.mermaid' })
    .then(() => { window.__mermaidDone = true; })
    .catch((e) => { window.__mermaidError = String(e && e.message ? e.message : e); window.__mermaidDone = true; });
</script>
</body>
</html>`;

const htmlPath = outputHtml ?? outputPdf.replace(/\.pdf$/i, '.html');
await writeFile(htmlPath, html, 'utf8');

/*
 * Chromium comes from whichever Playwright build is already on the machine, found rather
 * than assumed.
 *
 * playwright-core insists on the exact build its own version pins - ask it for chromium
 * and it looks for one revision and nothing else, so a machine with a newer or older
 * browser gets "Executable doesn't exist" and an instruction to install a second copy.
 * The e2e suite has already downloaded one; this finds the newest of them. Override with
 * PUPPETEER_EXECUTABLE_PATH to use a different browser.
 */
const findChromium = async () => {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const root =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
      : path.join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  const { readdir, access } = await import('node:fs/promises');
  let names = [];
  try {
    names = await readdir(root);
  } catch {
    return undefined; // no Playwright cache; let playwright-core try its own default
  }
  const candidates = names
    .filter((n) => /^chromium(_headless_shell)?-\d+$/.test(n))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const name of candidates) {
    for (const exe of [
      path.join(root, name, 'chrome-win', 'chrome.exe'),
      path.join(root, name, 'chrome-win', 'headless_shell.exe'),
      path.join(root, name, 'chrome-linux', 'chrome'),
      path.join(root, name, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ]) {
      try {
        await access(exe);
        return exe;
      } catch {
        /* next */
      }
    }
  }
  return undefined;
};

const browser = await chromium.launch({ executablePath: await findChromium() });
const page = await browser.newPage();
await page.goto('file:///' + path.resolve(htmlPath).replace(/\\/g, '/'), {
  waitUntil: 'load',
});
await page.waitForFunction('window.__mermaidDone === true', null, { timeout: 120_000 });

const error = await page.evaluate('window.__mermaidError');
const rendered = await page.evaluate("document.querySelectorAll('pre.mermaid > svg').length");
const expected = diagrams.length;

await page.pdf({
  path: outputPdf,
  // The @page rules decide the size and the margins, which is what lets a single
  // document mix portrait prose with landscape figures.
  preferCSSPageSize: true,
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="width:100%;font:8pt \'Segoe UI\',Arial,sans-serif;color:#697186;padding:0 16mm;display:flex;justify-content:space-between;">' +
    `<span>${title.replace(/</g, '')}</span><span class="pageNumber"></span></div>`,
});
await browser.close();

console.log(
  `${path.basename(outputPdf)}: ${rendered}/${expected} diagrams rendered${error ? ' — mermaid error: ' + error : ''}`,
);
if (error || rendered !== expected) process.exit(1);
