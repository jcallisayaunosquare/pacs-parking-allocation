## What and why

<!-- One subject. The behaviour that changes, and the reason it has to. If this fixes
something found in use, say how it showed up: the error, the screen, the trace id. -->

## What I considered and rejected

<!-- The alternative a reviewer would suggest, and why it is not this. "Nothing" is a
valid answer for a small change; leaving the section empty is not. -->

## How it was verified

- [ ] Unit tests beside the code that changed (`*.spec.ts`)
- [ ] `pnpm -r lint` and `pnpm -r typecheck`
- [ ] Tried in the app (offline stub or dev), if a screen changed

## Release notes

<!-- Tick whatever applies, and say what the person releasing must do. -->

- [ ] Needs a migration, applied by hand **before** the deploy (`pnpm --filter @pacs/api migrate:up`)
- [ ] Changes `serverless.yml` or the pipeline templates
- [ ] Changes the contract (`packages/contracts/openapi.yaml`)
- [ ] Changes what an administrator or a resident sees, so it goes in the release note
- [ ] Changes a documented fact: `docs/delivery/` updated in this pull request
