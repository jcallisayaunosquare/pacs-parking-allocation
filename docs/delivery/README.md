# PACS — delivery documentation

Three documents, each as Markdown with its diagrams as `mermaid` blocks, and as a PDF with
those diagrams rendered.

| | What it is | For |
|---|---|---|
| [`01-technical-documentation.md`](01-technical-documentation.md) · [PDF](01-technical-documentation.pdf) | What the system is, the architecture front and back, the AWS and network topology, the data model, the domain rules, the API, how to run it, how to deploy it, the test strategy, and the known constraints | An engineer picking the project up |
| [`02-communication-plan.md`](02-communication-plan.md) · [PDF](02-communication-plan.pdf) | Code review practice, sprint planning and the decision-making process, grounded in what this repository actually enforces | The team, and anyone asking how work gets agreed here |
| [`03-onboarding-guide.md`](03-onboarding-guide.md) · [PDF](03-onboarding-guide.pdf) | A path from a fresh clone to a merged pull request: what to read in what order, how to get it running, a first issue, the conventions, and how to get through review | A developer joining |

Everything in these documents was checked against the code in this repository, and the
parts that concern deployed infrastructure were checked against the `dev` account. Where
the code and the original specification (`../analisis.html`) disagree, the code is treated
as correct and the disagreement is named — see §13 of the technical documentation.

## Regenerating the PDFs

`marked`, `mermaid` and `playwright-core` are devDependencies of the workspace root, so
`pnpm install` is all the setup there is. The browser comes from whichever Playwright build
is already on the machine - the e2e suite has downloaded one - and the script finds it
rather than pinning a revision; `PUPPETEER_EXECUTABLE_PATH` overrides that. It exits
non-zero if any diagram fails to render, so a silent blank figure cannot ship.

The Markdown is the source. `render-pdf.mjs` turns it into HTML, lets mermaid's own bundle
replace each `mermaid` block with an SVG, and prints the page from Chromium — so every
diagram in the PDF is vector, searchable and zoomable rather than a screenshot.

It is a standalone script with three dependencies that are **not** part of this workspace,
so run it from a directory where they are installed rather than from here:

```bash
mkdir /tmp/pacs-docs && cd /tmp/pacs-docs
npm install marked@16.4.0 mermaid@11.12.0 playwright-core@1.63.0
# Chromium: the one Playwright already has, under %LOCALAPPDATA%\ms-playwright on Windows
export PUPPETEER_EXECUTABLE_PATH=".../chromium-1243/chrome-win64/chrome.exe"
node <repo>/docs/delivery/render-pdf.mjs <repo>/docs/delivery/01-technical-documentation.md \
                                         <repo>/docs/delivery/01-technical-documentation.pdf
```

It prints how many diagrams it rendered out of how many it found, and exits non-zero if
mermaid reported a parse error — so a broken diagram fails the run rather than shipping as
an error box in a PDF nobody re-reads.

Two HTML comments control how a diagram is laid out. Both are invisible to every other
Markdown renderer, so the source stays portable:

```markdown
<!-- figure:wide -->   the diagram gets its own landscape page
<!-- figure:page -->   the diagram gets its own portrait page, with narrow margins
```

Without one, a diagram flows with the prose and is scaled to the text measure.
