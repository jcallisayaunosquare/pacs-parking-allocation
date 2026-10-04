# PACS — Parking Allocation Context System

Backend for the fair, auditable quarterly parking raffle specified in
[`../analisis.html`](../analisis.html) rev 2.2. That document is the spec of record;
this README only covers how to run what is built.

| | |
|---|---|
| Runtime | Node.js 24 on Lambda (`nodejs24.x`, arm64) · TypeScript strict |
| HTTP | API Gateway HTTP API + native Cognito JWT authorizer |
| Data | RDS PostgreSQL 18.3 (`hotel-db`, database `pacs_dev`) · Kysely · node-pg-migrate |
| Cache | DynamoDB with TTL (ADR-017) |
| IaC | Serverless Framework v4 |
| Region | **us-east-2** — the only region the account's SCP permits |

## Deployed (stage `dev`)

| | |
|---|---|
| API | `https://frd8e8nkhl.execute-api.us-east-2.amazonaws.com` |
| Cognito issuer | `https://cognito-idp.us-east-2.amazonaws.com/us-east-2_NsdZ4M0mj` |
| User pool · client | `us-east-2_NsdZ4M0mj` · `2tu4q5vefr1g98u90u8dspmife` |
| Hosted login | `https://pacs-dev-309887812390.auth.us-east-2.amazoncognito.com` |
| Cache table | `pacs-cache-dev` |
| Event bus | `pacs-events-dev` + stream → `integrations` |
| Functions | `pacs-api-dev-api`, `-runRaffle`, `-sweeper`, `-integrations` |

Those five values are what the Angular app needs. Verified after deploy:

```
pnpm test                        54/54 unit, including 10 000 seeded draws
node scripts/smoke.mjs           31/31 auth, RBAC, validation, state machine, idempotency
node scripts/verify-raffle.mjs   14/14 a real raffle over HTTPS, under 1 s
node scripts/verify-cognito.mjs  14/14 async Cognito provisioning, end to end
```

## How Cognito provisioning works

`POST /residents` runs inside the VPC and has **no route to Cognito** — that is the
price of having no NAT gateway (ADR-016). So it does not call it. Instead:

1. **api** (in VPC) writes the resident row, their fairness row and a `ResidentCreated`
   outbox event in **one transaction**. No event can outlive a rolled-back insert, and
   no insert goes unannounced.
2. It then pushes the event to `pacs-events` through the free DynamoDB gateway
   endpoint. Best-effort: this is latency, not correctness.
3. The stream fans out to **integrations**, the one function *outside* the VPC. It
   calls `AdminCreateUser` with `custom:resident_id`, adds the user to `RESIDENT`, and
   writes a `link#<sub>` item back to the table — it cannot reach the database itself.
4. On the resident's first authenticated request the API claims that link, sets
   `resident.external_subject` and deletes the item, so the link is written once.
5. If step 2 ever fails, **sweeper** relays the outbox row on its next pass. Delivery is
   at-least-once and every consumer in `integrations` is idempotent — an existing
   Cognito user is read, never recreated.

Measured end to end: the Cognito user exists about 3 seconds after the 201, and the
subject link about 1.5 seconds after that. Cognito's own default email sender delivers
the invitation, so no SES verification is involved.

## Layout

```
code/
├─ apps/api/                    the backend service
│  ├─ serverless.yml            functions, events, Cognito, DynamoDB, VPC endpoint
│  ├─ migrations/               node-pg-migrate, forward + down
│  ├─ scripts/                  seed and an end-to-end draw against a real database
│  └─ src/
│     ├─ shared/                kernel: Result, errors, Clock, db, cache, http
│     ├─ modules/               one Clean Architecture ring set per module (§08)
│     │  ├─ allocation/         M-1 — cycles, runs, the draw, waitlist
│     │  ├─ residents/          M-2
│     │  ├─ inventory/          M-3
│     │  ├─ fairness/           M-4 — scores, history, metrics
│     │  └─ identity/           M-6 — JWT claims → Principal, RBAC
│     └─ main/                  composition roots — the only place that calls `new`
├─ apps/web/                    the Angular frontend
│  └─ src/app/
│     ├─ core/                 OIDC config, auth store, guards, interceptors, errors
│     ├─ domain/               models + repository contracts as abstract classes
│     ├─ data/                 DTOs, mappers, HttpClient implementations
│     ├─ application/          signal facades with stale-while-revalidate
│     ├─ features/             lazy standalone pages (PrimeNG lives only here)
│     └─ shared/ui/            status pill, five-state host, fairness explainer
└─ packages/contracts/          OpenAPI 3.1 — source for client types and mock servers
```

Each module has the same three rings and source dependencies point inward only:
`domain/` is pure TypeScript with no `async` and no I/O, `application/` knows only
ports, `infrastructure/` knows Kysely, DynamoDB and Cognito. The draw is therefore
testable — and 10 000 times reproducible — without touching AWS.

## Prerequisites

- Node.js 22 or later (Lambda runs 24; the local tooling works on 22)
- pnpm 9 — `npm install -g pnpm@9`
- An AWS profile with access to the account. The commands below assume `hotel`.
- PostgreSQL client tools, if you want to poke at the database by hand

## Install

```bash
cd code
pnpm install
```

## The database connection

The connection details live in Secrets Manager at `dev/hotel-db/connection`
(`us-east-2`). Nothing is committed, and no password is passed on a command line.

Export a connection string once per shell for the migration and script commands:

```bash
# PowerShell
$s = aws secretsmanager get-secret-value --secret-id dev/hotel-db/connection `
       --profile hotel --region us-east-2 --query SecretString --output text | ConvertFrom-Json
$env:DATABASE_URL = "postgresql://$($s.username):$([uri]::EscapeDataString($s.password))@$($s.host):$($s.port)/pacs_dev?sslmode=no-verify"
```

The deployed functions never use this. They authenticate with **IAM database
authentication** as the `pacs_app` role: a token signed locally per connection, valid
15 minutes, so no database credential exists in the function configuration, in SSM or
in git.

## Migrate, seed, verify

```bash
pnpm --filter @pacs/api migrate:up      # schema of §11 — 11 tables, 36 indexes, 6 enums
pnpm --filter @pacs/api seed            # 24 residents, 10 spots, one open cycle
pnpm --filter @pacs/api exec tsx scripts/run-draw.ts
```

`run-draw.ts` is the integration layer of §27, runnable by hand. It wires the real
repositories to the real use case and asserts the things only Postgres can prove:

```
PASS  run completes
PASS  every spot filled                                    assigned=10
PASS  remainder waitlisted                                 waitlisted=14
PASS  NFR-01: under 2 s
PASS  no resident assigned twice · no spot assigned twice
PASS  24 history rows, one per participant
PASS  waitlist positions are 1..14 with no gaps
PASS  cycle moved to ACTIVE
PASS  accessibility pre-assignment honoured
PASS  every winner score reset to 0
PASS  replaying the idempotency key does not re-draw
PASS  guard 1: a second RUNNING run is rejected by the index
PASS  BR-05: app_user cannot UPDATE allocation_history
16/16 checks passed
```

## Test and typecheck

```bash
pnpm --filter @pacs/api test        # 54 unit tests, including 10 000 seeded draws
pnpm --filter @pacs/api typecheck
```

The statistical suite is the unusual one and the reason it exists: it checks the raffle
is *fair*, not merely that it runs. Win frequency must track `(score + 1) / Σ(score + 1)`
within a 15% relative band over 10 000 draws, and no entrant may ever have zero
probability.

## Deploy

Both prerequisites are already done on this account — IAM database authentication is
enabled on `hotel-db` and the `pacs_app` role exists. For a fresh account:

```bash
aws rds modify-db-instance --db-instance-identifier hotel-db \
    --enable-iam-database-authentication --apply-immediately \
    --profile hotel --region us-east-2
aws rds wait db-instance-available --db-instance-identifier hotel-db \
    --profile hotel --region us-east-2
pnpm --filter @pacs/api migrate:up   # creates pacs_app and grants it rds_iam
```

Then:

```bash
cd apps/api
serverless deploy --stage dev --aws-profile hotel --region us-east-2
node scripts/smoke.mjs               # post-deploy smoke set (§23)
```

### Two things that will bite on a fresh deploy

**Handler filenames must contain no dots.** The bundle is flattened, and the Node
runtime splits the handler string at the *first* dot — so `src/main/api.handler.ts` with
handler `src/main/api.handler.handler` fails at init with `Cannot find module 'api'`.
The files are therefore `api.ts`, `run-raffle.ts`, `sweeper.ts`. §10 of the document
still shows the `*.handler.ts` convention; it does not work.

**Reserved concurrency is impossible on a new account.** The Lambda quota starts at 10
concurrent executions and AWS requires 10 to stay unreserved, so any
`reservedConcurrency` fails the stack. The reservations of §10 are commented out with
the reasoning; raise the quota, then restore them.

Serverless Framework v4 needs a vendor login in CI (`SERVERLESS_ACCESS_KEY`); it is
free for individuals and for organisations under the vendor's revenue threshold.
Confirm the licence terms before using it for a company account (ADR-011).

The stack creates: three functions (`api`, `runRaffle`, `sweeper`), an HTTP API with a
Cognito JWT authorizer, a Cognito user pool with `ADMIN`/`RESIDENT` groups and a hosted
login domain, the `pacs-cache` DynamoDB table, and a free DynamoDB gateway endpoint —
which is what removes the NAT gateway (ADR-016).

Outputs include `ApiBaseUrl`, `UserPoolId`, `UserPoolClientId`, `CognitoIssuer` and
`CognitoHostedUi`; the Angular app needs all five.

## Endpoints

The full contract is [`packages/contracts/openapi.yaml`](packages/contracts/openapi.yaml).
Every route except `GET /health` needs a bearer token. `{id}` parameters are UUIDs and
are rejected before they reach a query, so records cannot be enumerated.

| Method & path | Role | Purpose |
|---|---|---|
| `GET /health` | public | Liveness |
| `GET /me` | any | Principal profile, from the token only |
| `GET /me/dashboard` | any | UC-09 aggregated status · cached 5 min |
| `GET /me/history` | any | UC-10 own history |
| `POST /me/assignment/release` | any | UC-11 give up a spot · promotes the waitlist |
| `POST /cycles/{id}/registrations` | any | UC-08 enter the raffle · idempotent |
| `DELETE /cycles/{id}/registrations/me` | any | Withdraw while registration is open |
| `GET` · `POST /residents` | admin | List · FR-10 create + provision Cognito user |
| `GET` · `PATCH` · `DELETE /residents/{id}` | admin | Detail · edit · soft delete |
| `PATCH /residents/{id}/eligibility` | admin | FR-15 · requires a reason |
| `GET` · `POST /spots` | admin | FR-16 inventory |
| `PATCH /spots/{id}` | admin | Edit / deactivate · refuses if assigned |
| `GET` · `POST /cycles` | admin | UC-04 cycles |
| `POST /cycles/{id}/open-registration` | admin | DRAFT → REGISTRATION_OPEN |
| `POST /cycles/{id}/close-registration` | admin | Manual close |
| `POST /cycles/{id}/runs` | admin | UC-05 run · `Idempotency-Key` required |
| `GET /runs/{id}` | admin | Run detail + the seed, for audit |
| `GET /runs/{id}/assignments` | admin | Full result set |
| `GET /metrics/fairness` | admin | FR-22 dashboard · cached 10 min |
| `GET /reports/quarterly/{cycleId}` | admin | UC-07 export · `?format=csv` |

Errors use one shape, with a `traceId` matching the log correlation id:

```json
{
  "error": "RAFFLE_IN_PROGRESS",
  "message": "An allocation run is already executing for this cycle.",
  "traceId": "7b4e…",
  "timestamp": "2026-03-26T02:00:00Z"
}
```

## Where this deviates from analisis.html rev 2.2

Each of these is a decision forced by the real account, not a design change. §10 of the
document still needs updating to match.

| Document says | Reality | Why |
|---|---|---|
| `us-east-1` | **`us-east-2`** | SCP `p-wvjo6arp` on account 309887812390 denies every other region |
| RDS PostgreSQL 17 | **18.3** | The existing `hotel-db` instance |
| Dedicated instance | Shares `hotel-db` | Reuses what exists; `pacs_dev` is its own database |
| Private subnets, no public access | **Publicly accessible**, SG open to one `/32` | Requested, so migrations and scripts can run from a laptop. Reverting is two commands — see below |
| `migrate` Lambda in the VPC | Migrations run from a laptop or CI | Only needed while the database is unreachable from outside; put it back when access is closed |
| Per-function IAM roles via plugin | One scoped service role | Avoids a plugin whose v4 support is unverified; the statements are still resource-scoped with no wildcards |
| Master DB password in SSM | **No database password at all** | IAM database authentication: a token signed locally per connection. Strictly better than §10, and it is what §10's own security list asks for |
| Master DB password in SSM | **No database password at all** | IAM database authentication: a token signed locally per connection. Strictly better than §10, and it is what §10's own security list asks for |
| `reservedConcurrency` api 10 / jobs 1–2 | None | Account quota is 10 concurrent executions; AWS requires 10 unreserved. The quota itself bounds the pool at 10 × 2 = 20 connections |
| `custom:resident_id` claim identifies the caller | Claim, else `sub`, else a pending link | Cognito puts custom attributes in the **ID token only**, and the API is called with an access token, so the claim is normally absent. The id still comes only from the verified token |

To close public access again:

```bash
aws ec2 revoke-security-group-ingress --group-id sg-0b745610ae460e557 \
    --security-group-rule-ids sgr-099aad7e62bcc6f11 --profile hotel --region us-east-2
aws rds modify-db-instance --db-instance-identifier hotel-db \
    --no-publicly-accessible --apply-immediately --profile hotel --region us-east-2
```

## The frontend

```bash
cd apps/web
pnpm start     # http://localhost:4200, against the deployed dev API
pnpm build     # production bundle into dist/web
pnpm test      # 11 boundary tests
```

| | |
|---|---|
| Angular | **22.2** — zoneless, standalone, signals, no zone.js |
| PrimeNG | **22.1** with the Aura preset and `@primeuix/themes` 3 |
| Auth | `angular-auth-oidc-client` 22 · authorization code + PKCE · tokens in memory |
| Node | Angular 22 needs `^22.22.3 \|\| ^24.15.0 \|\| >=26` |

Six screens, lazy-loaded, so a resident never downloads the admin bundle:
`/` dashboard · `/history` · `/admin/residents` · `/admin/spots` ·
`/admin/cycles` · `/admin/metrics`.

The rings mirror the backend's. `domain/` is plain TypeScript with no Angular import
beyond types; `data/` is the only place that knows `HttpClient` exists; facades expose
signals and own refetch, so pages stay presentational; PrimeNG appears only under
`features/` and `shared/ui/`. The bindings live in one place, `app.config.ts`, which is
what makes a fake repository a one-line swap.

Two details worth knowing before changing it:

**PrimeNG 22 dropped the camelCase selectors.** `<p-confirmDialog>` is now
`<p-confirm-dialog>`, `<p-progressSpinner>` → `<p-progress-spinner>`,
`<p-toggleSwitch>` → `<p-toggle-switch>`. The modules kept their names, so the failure
is `NG8001: not a known element` with an import that looks correct.

**The initial bundle is 805 kB raw / 177 kB transferred.** Angular's default 500 kB
warning is on raw size and Angular + PrimeNG + OIDC do not fit in it; the budget is set
to 850 kB with the error at 1 MB. The number that matters is the 177 kB that crosses the
wire.

### Still missing on the frontend

- Transloco is installed but not wired. §17 requires Spanish and English; the copy is
  currently Spanish literals, which is the gap
- §17 asks for the fairness explanation as a message key plus parameters so it can be
  translated. The API returns finished prose, so the sentence cannot be localised
  without changing the contract — the one real design debt here
- No CloudFront/S3 deployment yet, so `environment.production.ts` still points its
  redirect URLs at localhost

## Not built yet

- The Angular + PrimeNG frontend (`apps/web`) — the contract and a working API exist
- SES notification templates (M-5). `integrations` already receives the allocation
  events and logs them; only the templates and the send call are missing. **SES is in
  sandbox** (`ProductionAccessEnabled: false`, 200/day): it can only send to verified
  addresses until production access is requested
- Playwright E2E and k6 load suites (§27 names both)
- CI workflow with GitHub Actions and OIDC (§23, ADR-018)
- `git init` — this is not a repository yet
