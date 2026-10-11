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
 *   <!-- figure:wide -->   a landscape page, for a diagram wider than it is tall
 *   <!-- figure:page -->   the full text column, for one that needs every millimetre of it
 *
 * Without one it is `flow`: it sits in the prose at the text measure. All three are the
 * same kind of object - a block that is never split and never parted from its heading -
 * and they differ only in how much width they are given. The comment is invisible in every
 * other Markdown renderer, so the source stays portable.
 *
 * `wide` is the only one that costs a page break, because a landscape page is a different
 * @page and the size change forces one at each end of it. So it is reserved for diagrams
 * that are genuinely wider than a landscape page is - the render prints a warning for any
 * that are not, since for those the landscape page is less room, not more.
 */
const diagrams = [];
const withPlaceholders = source.replace(
  /(?:<!--\s*figure:(wide|page)\s*-->\s*\r?\n)?```mermaid\r?\n([\s\S]*?)```/g,
  (_m, mode, body) => {
    diagrams.push({ body, mode: mode ?? 'flow' });
    return `\n\nMERMAIDPLACEHOLDER${diagrams.length - 1}ENDPLACEHOLDER\n\n`;
  },
);

marked.setOptions({ gfm: true, breaks: false });
let body = await marked.parse(withPlaceholders);

body = body.replace(/<p>MERMAIDPLACEHOLDER(\d+)ENDPLACEHOLDER<\/p>/g, (_m, i) => {
  const { body: src, mode } = diagrams[Number(i)];
  const text = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div class="figure figure--${mode}"><pre class="mermaid">${text}</pre></div>`;
});

/*
 * A figure takes its heading, and the line that introduces it, with it.
 *
 * The heading says `break-after: avoid`, but an avoidance is only a request and it loses
 * to anything that makes the figure move: a forced break, or a `break-inside: avoid` block
 * too tall for what is left of the page. Either way the heading was left behind as the
 * last line of the previous page - often the only line on it - and the diagram began the
 * next. Moving the heading *inside* the container is what actually fixes it: there is then
 * nothing between them to break.
 *
 * The two passes are for `## 3. Architecture` immediately followed by `### 3.1 ...`: the
 * first pass takes the h3, the second takes the h2 that now sits against the container.
 *
 * Both the heading and the optional intro paragraph are tempered so they cannot run past
 * their own closing tag. An untempered `[\s\S]*?</h2>` looks harmless and is not: with the
 * global flag it backtracks to whichever `</h2>` happens to be followed by a figure, so
 * the match - and the move - swallowed everything in between. One `figure--wide` div ended
 * up holding sections 1 to 3.3, three diagrams and a table, inside a single
 * `break-inside: avoid` landscape block. Measured, not guessed: that one div was 16.7 KB.
 */
const absorbIntoFigure =
  /(<h([2-4])[^>]*>(?:(?!<\/?h[2-4]\b)[\s\S])*?<\/h\2>)\s*((?:<p>(?:(?!<\/?[ph]\b)[\s\S])*?<\/p>\s*)?)(<div class="figure figure--[a-z]+">)/g;
for (let pass = 0; pass < 2; pass += 1) {
  body = body.replace(absorbIntoFigure, (_m, heading, _level, intro, open) => open + heading + intro);
}

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
  /* A diagram that is wider than a landscape page gets one. Nothing else does.

     Rotating the wide ones onto portrait pages instead was tried, to be rid of the mixed
     page sizes: a transform does not affect layout, the reserved box did not hold, and
     the prose printed over the figures. Measured, not guessed - the document collapsed
     from 55 pages to 18 with twice the marks on each. Reverted.

     There used to be a second named page, tall, which was a portrait page with the
     margins narrowed to 12mm. It bought a figure 12mm of height and 8mm of width, and it
     cost a forced page break at each end, because leaving a named page forces one: the
     paragraph after such a figure could not share its page and was printed alone on the
     next. That is where pages carrying two lines came from. The 8mm of width is recovered
     below with a negative margin on figure--page, which costs nothing. */
  @page wide { size: A4 landscape; margin: 12mm 12mm 14mm; }
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
  /* A diagram is centred and never split across a page. */
  pre.mermaid {
    background: none;
    border: 0;
    padding: 0;
    margin: 0;
    text-align: center;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  pre.mermaid svg { max-width: 100%; height: auto; }

  /* A figure is heading + intro line + drawing, kept whole.
     break-before and break-after are both deliberately absent. A forced break beat the
     heading's break-after: avoid and stranded it on the page before; and forcing one
     after pushed whatever followed onto a page of its own, which with two figures in a
     row produced a page holding nothing but white. break-inside: avoid alone is
     enough, *provided* the block fits a page - which is what the measured height cap
     below guarantees. Chrome then moves the whole block, heading included, and the prose
     before and after it fills the pages it did not need. */
  .figure {
    break-inside: avoid;
    page-break-inside: avoid;
    margin: 1.2em 0 1.4em;
  }
  /* The spacing lives on the container, not on the pre: a margin on the first or last
     child collapses out through a parent with no padding, and the height measured for
     the cap would then be short by that much. */
  .figure > h2,
  .figure > h3,
  .figure > h4 {
    margin-top: 0;
    margin-bottom: 0.45em;
  }
  .figure > p { margin: 0 0 0.7em; }
  /* A figure heading is set one step down from a prose heading of the same level. It is
     read against the drawing rather than against a wall of text, and the millimetres it
     gives back are millimetres the drawing gets. */
  .figure > h2 { font-size: 13pt; }
  .figure > h3 { font-size: 11pt; }
  .figure > h4 { font-size: 10pt; }
  /* figure--page has no geometry of its own: it is the text column, like figure--flow.
     Recovering the 8mm the old narrow-margin page used to buy, as margin-inline: -4mm,
     was tried and silently mutilated the document. Chrome clips printed content to the
     margin box when displayHeaderFooter is on, so the 4mm of overhang was not printed:
     every heading on such a figure lost its leading characters - "6.4 Physical" came out
     as "4 Physical" - and the drawing lost 4mm off each side. Measured, not guessed: it
     is visible at 4x on page 19. 8mm is not worth a silent crop. */
  .figure--wide { page: wide; }
  /* Prose that the measuring pass moves onto a landscape page keeps a readable measure:
     a paragraph set across the full 273mm runs to about 150 characters a line. */
  .figure--wide > p,
  .figure--wide > ul,
  .figure--wide > ol,
  .figure--wide > blockquote { max-width: 170mm; margin-inline: auto; }
  /* No max-height here: it is set per figure, measured, just before printing. A figure
     has to fit one page *together with its heading*, and how tall the heading is depends
     on how many lines it wraps to - which a stylesheet cannot know. The caps that used to
     be written here (168mm and 252mm) were chosen when the headings were still outside
     the container, and an unmarked diagram had no cap at all: the deploy flowchart came
     out 476mm tall on a 259mm page and was simply cut in half. */
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
  /*
   * The height cap, measured rather than declared.
   *
   * Every figure must fit one page together with its heading and its intro line, or
   * break-inside: avoid is ignored and the drawing is cut across the break. So once
   * mermaid has drawn everything, each block is measured, the drawing's own height is
   * subtracted, and the drawing is capped at whatever is left of the page's content box.
   * The SVG carries a viewBox, so a height cap scales it whole instead of cropping it.
   *
   * Then everything is measured again, because the first measurement is of a layout that
   * no longer exists, and the second one is the number that decides whether a page splits.
   * Anything still too tall is reported by the renderer rather than printed clipped.
   */
  window.__fitReport = null;
  const fitFigures = () => {
    const MM = 96 / 25.4;
    // A4 less the @page margins: 297 - 18 - 20 portrait, 210 - 12 - 14 landscape.
    const limitMm = (fig) => (fig.classList.contains('figure--wide') ? 184 : 259);
    // Chrome's printed content box comes out a little short of the arithmetic and a
    // drawing one millimetre too tall takes a whole page with it. This is that slack.
    const SAFETY_MM = 6;
    const figures = [...document.querySelectorAll('.figure')].filter((f) =>
      f.querySelector('pre.mermaid > svg'),
    );
    for (const fig of figures) {
      const svg = fig.querySelector('pre.mermaid > svg');
      const chrome = fig.getBoundingClientRect().height - svg.getBoundingClientRect().height;
      const cap = (limitMm(fig) - SAFETY_MM) * MM - chrome;
      svg.style.maxHeight = Math.max(40 * MM, cap) + 'px';
    }
    /*
     * A landscape page is 273mm wide and 184mm tall, and a diagram that has earned one is
     * wide rather than tall: the network map is 64mm of those 184. Printing the remaining
     * 120mm as white and then forcing a page break so the prose can resume in portrait
     * wastes two thirds of a sheet, so the paragraphs that explain the diagram are moved
     * onto the page with it - as many as fit, which is not something a stylesheet can ask.
     */
    for (const fig of document.querySelectorAll('.figure--wide')) {
      const room = (184 - 2) * MM;
      const before = fig.getBoundingClientRect().height;
      const moved = [];
      for (;;) {
        const next = fig.nextElementSibling;
        if (!next) break;
        // mermaid leaves its own stylesheet holders in the flow; they draw nothing.
        if (next.id && next.id.startsWith('mermaid-')) {
          fig.appendChild(next);
          continue;
        }
        if (!/^(P|UL|OL|BLOCKQUOTE)$/.test(next.tagName)) break;
        fig.appendChild(next);
        if (fig.getBoundingClientRect().height > room) {
          fig.parentNode.insertBefore(next, fig.nextSibling);
          break;
        }
        moved.push(next);
      }
      /*
       * All or nothing. The paragraph after a diagram is often a single line introducing
       * the list that follows it, and that list rarely fits what is left of the page: the
       * landscape page then carried the figure, one orphaned line and 120mm of white,
       * while the list it introduced began the next page without it. Moving nothing is
       * better than that, so a gain this small is given back.
       */
      if (fig.getBoundingClientRect().height - before < 20 * MM) {
        for (const el of moved.reverse()) fig.parentNode.insertBefore(el, fig.nextSibling);
      }
    }
    return figures.map((fig) => {
      const svg = fig.querySelector('pre.mermaid > svg');
      const box = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const heading = fig.querySelector('h2, h3, h4');
      return {
        heading: heading ? heading.textContent.trim() : '(no heading)',
        mode: fig.classList.contains('figure--wide')
          ? 'wide'
          : fig.classList.contains('figure--page')
            ? 'page'
            : 'flow',
        blockMm: Math.round(fig.getBoundingClientRect().height / MM),
        limitMm: limitMm(fig),
        drawnMm: Math.round(box.width / MM) + 'x' + Math.round(box.height / MM),
        ratio: vb && vb.height ? +(vb.width / vb.height).toFixed(2) : null
      };
    });
  };
  mermaid
    .run({ querySelector: 'pre.mermaid' })
    .then(() => { window.__fitReport = fitFigures(); window.__mermaidDone = true; })
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

/*
 * What the measuring pass found, for the two faults a stylesheet cannot catch.
 *
 * A block still taller than its page will be split and the drawing cut, so that is an
 * error. A `wide` figure whose drawing is narrower than a landscape page is in proportion
 * is a classification mistake rather than a fault: it is being given 184mm of height where
 * a portrait page would have given it 259mm, and the two page breaks the landscape page
 * forces are paid for nothing. 273/184 is the landscape content box, so that is the ratio
 * a figure has to beat to deserve one.
 */
const fit = (await page.evaluate('window.__fitReport')) ?? [];
const tooTall = fit.filter((f) => f.blockMm > f.limitMm);
const notWide = fit.filter((f) => f.mode === 'wide' && f.ratio !== null && f.ratio < 273 / 184);
for (const f of tooTall) {
  console.error(`  figure too tall for its page: ${f.blockMm}mm of ${f.limitMm}mm — ${f.heading}`);
}
for (const f of notWide) {
  console.error(
    `  figure:wide on a diagram of ratio ${f.ratio}, which a portrait page suits better — ${f.heading}`,
  );
}

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
if (error || rendered !== expected || tooTall.length > 0) process.exit(1);
