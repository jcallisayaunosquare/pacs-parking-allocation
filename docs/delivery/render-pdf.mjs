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
  return mode ? `<div class="figure figure--${mode}">${figure}</div>` : figure;
});

const title = (source.match(/^#\s+(.+)$/m) ?? [, path.basename(input)])[1];

const html = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm; }
  /* A figure too large for the text measure gets a page of its own and narrow margins.
     Landscape when it is wider than it is tall; portrait when it is not. */
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
  .figure { break-before: page; break-after: page; }
  .figure pre.mermaid { margin: 0; }
  .figure--wide { page: wide; }
  .figure--wide pre.mermaid svg { max-height: 178mm; }
  .figure--page { page: tall; }
  .figure--page pre.mermaid svg { max-height: 265mm; }
</style>
</head>
<body>
${body}
<script>${mermaidJs}</script>
<script>
  window.__mermaidDone = false;
  window.__mermaidError = null;
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
const rendered = await page.evaluate("document.querySelectorAll('pre.mermaid svg').length");
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
