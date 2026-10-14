# PACS — Parking Allocation Context System

Fair, auditable allocation of a residential building's parking bays: residents enter a
period, a deterministic draw ranks them by waiting time, and every result can be explained
and re-derived. Includes a gate that reads number plates.

## Documentation

Start here. Each document is Markdown (readable on GitHub, diagrams included) and PDF.

| Document | What it covers | Read it if you are |
|---|---|---|
| **[Technical documentation](docs/delivery/01-technical-documentation.md)** · [PDF](docs/delivery/01-technical-documentation.pdf) | Architecture front and back, AWS and network, data model, fairness rules A–H, API, running locally, deploying, testing, operating the environment, known gaps | An engineer picking the project up |
| **[Communication plan](docs/delivery/02-communication-plan.md)** · [PDF](docs/delivery/02-communication-plan.pdf) | Code review, sprint planning, how decisions are made, channels, a real incident from report to release | On the team, or asking how work gets agreed |
| **[Onboarding guide](docs/delivery/03-onboarding-guide.md)** · [PDF](docs/delivery/03-onboarding-guide.pdf) | From a fresh clone to a merged pull request, the conventions and why, a first issue, and how a junior developer is guided | Joining the project |
| [Product brief](apps/web/PRODUCT.md) | Who the users are, what they need, what may never change | Deciding what to build |
| [Original specification](docs/analysis.html) | The analysis the project started from, with the ADRs. Where it and the code disagree, the code wins — see §13 of the technical documentation | Tracing the history of a decision |
| [API contract](packages/contracts/openapi.yaml) | OpenAPI 3.1; served as Swagger UI at `GET /docs` on the API | Calling the API |

**Live (dev):** app <https://d2gamvhpvfk16e.cloudfront.net> ·
API <https://frd8e8nkhl.execute-api.us-east-2.amazonaws.com> ·
Swagger <https://frd8e8nkhl.execute-api.us-east-2.amazonaws.com/docs>

**Quick start**, no AWS needed:

```bash
pnpm install
pnpm --filter @pacs/api local        # stub API on http://localhost:4300
cd apps/web && pnpm offline          # app on http://localhost:4200 — admin@local or resident@local, any password
```

The rest of this README is the backend's operating notes. Where it and the documents
above disagree, the documents are newer.

| | |
|---|---|
| Runtime | Node.js 24 on Lambda (`nodejs24.x`, arm64) · TypeScript strict |
| HTTP | API Gateway HTTP API + native Cognito JWT authorizer |
| Data | RDS PostgreSQL 18.3 (`hotel-db`, database `pacs_dev`) · Kysely · node-pg-migrate |
| Cache | DynamoDB with TTL (ADR-017) |
| Vision | Amazon Rekognition `DetectText`, behind a `PlateRecognizer` port (M-7) |
| IaC | Serverless Framework v4 |
| Region | **us-east-2** — the only region the account's SCP permits |

## API documentation (Swagger UI)

The API serves interactive documentation at `GET /docs` and the
OpenAPI 3.1 contract at `GET /openapi.yaml`. Both documentation endpoints are public;
business endpoints retain their Cognito authorizer and role checks.

For local use, run `pnpm --filter @pacs/api local` and open
<http://localhost:4300/docs>. This server uses in-memory fixtures and stub authentication.
After deploying this change, the same `/docs` path is available on the deployed API.

Use **Authorize** to paste a Cognito access token without the `Bearer` prefix, then
**Try it out** to call endpoints on the API serving the page. Tokens are not persisted
across reloads. Calls can modify data according to the endpoint's normal permissions.
Swagger UI loads its pinned JS/CSS version from UNPKG, so the browser needs internet.
The contract is bundled directly from `packages/contracts/openapi.yaml`; no second copy
is maintained. This adds a documentation viewer, not automatic route/contract generation.

## Deployed configuration (stage `dev`)

| | |
|---|---|
| API | `https://frd8e8nkhl.execute-api.us-east-2.amazonaws.com` |
| Cognito issuer | `https://cognito-idp.us-east-2.amazonaws.com/us-east-2_NsdZ4M0mj` |
| User pool · client | `us-east-2_NsdZ4M0mj` · `2tu4q5vefr1g98u90u8dspmife` |
| Hosted login | `https://pacs-dev-309887812390.auth.us-east-2.amazoncognito.com` |
| Cache table | `pacs-cache-dev` |
| Event bus | `pacs-events-dev` + stream to `integrations` and `plateIngest` |
| Captures bucket | `pacs-captures-dev` |
| Functions | `pacs-api-dev-api`, `-runRaffle`, `-sweeper`, `-integrations`, `-plateRecognizer`, `-plateIngest` |

Those five values are what the Angular app needs. Verified after deploy:

```
pnpm test                        267/267 unit, including 10 000 seeded draws
node scripts/smoke.mjs           48/48 auth, RBAC, validation, state machine, idempotency
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
3. The stream fans out to **integrations**, a function *outside* the VPC. It
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

## Plate recognition (M-7)

A camera at the gate reads a plate; the system records what it read, matches it against
the resident vehicle register, decides allow or deny, and sends anything doubtful to a
human. The design is in `MODULO-PLACAS.md` and the AWS shape and engine comparison in
`DESPLIEGUE-LAMBDA.md`.

```
camera --POST /captures--> api (in VPC) --presigned PUT--> S3 pacs-captures-dev/raw/...
                                                             |  ObjectCreated:Put
                                                             v
                          plateRecognizer   OUTSIDE the VPC: sees S3 + Rekognition
                            DetectText (S3Object, no bytes transferred)
                            PutItem  pk = plateread#<captureId>
                                                             |
                                             DynamoDB pacs-events-dev (stream)
                                                             v
                          plateIngest       INSIDE the VPC: applies it to Postgres
                            plate_read + access_event + event_outbox
```

**Why two functions.** There is no NAT gateway (ADR-016). An in-VPC function reaches RDS
and DynamoDB through a free gateway endpoint and nothing else, so it cannot call
Rekognition or S3; a function outside the VPC can, and cannot reach `hotel-db`. The
alternatives were a NAT gateway (~32 USD/month, exactly what ADR-016 avoided) or a
Rekognition interface endpoint (~7.30 USD per availability zone per month — over three
subnets, more than this building's entire inference bill). So the event table sits between
them: the Cognito provisioning pattern, inverted. A DynamoDB stream is polled by the
Lambda service rather than by the function, so `plateIngest` can be triggered without
having any outbound route of its own.

**The engine is Rekognition `DetectText`, behind a port.** It is the most expensive of the
three options per read (~1.03 USD per 1000, about 9.30 USD/month at 300 reads a day) and
still the right one: it is the only option that adds no second language to the monorepo,
the Python container route carries `ultralytics`' AGPL-3.0 obligation, and an 8-15 second
cold start fails the first car of the day at a gate with no queue. Its weakness is
precision, and that is answered by design rather than by hope — a Bolivian format table, a
scene-word blocklist, a confidence threshold, a review queue, and an evaluation set that
builds itself from every correction. If week one says it is not good enough, the change is
one class in `infrastructure/` and one line in `src/main`, because recognition sits behind
the `PlateRecognizer` port.

**Thresholds.** `fused = confidence * (0.6 + 0.4 * quality)`. At or above `min_fused`
(0.85) an exact or lone fuzzy match opens the gate; between `review_fused` (0.55) and that
it goes to review; below it the read is unreadable and produces **no** access event,
because a dirty lens is not a refused entry. They live in `plate_config`, append-only, so
recalibrating is an `INSERT` and not a deploy — the environment variables are only the
cold-start default.

### Deploy steps

```bash
cd apps/api

# 1. The three new tables. From a laptop with DATABASE_URL exported, as below.
pnpm --filter @pacs/api migrate:up     # plate_config, plate_read, access_event

# 2. Deploy. Creates plateRecognizer (no VPC), plateIngest (in VPC), the captures
#    bucket with its lifecycle rules, the CAMERA Cognito group and two alarms.
serverless deploy --stage dev --aws-profile hotel --region us-east-2

# 3. Confirm the S3 trigger actually attached. This is the step that silently fails.
aws s3api get-bucket-notification-configuration \
    --bucket pacs-captures-dev --profile hotel --region us-east-2

# 4. One camera user per gate, in the CAMERA group. Its only permission is POST /captures,
#    so rotating a gate's credential touches no resident and no other gate.
aws cognito-idp admin-create-user --user-pool-id us-east-2_NsdZ4M0mj \
    --username gate-north@cameras.invalid --profile hotel --region us-east-2
aws cognito-idp admin-add-user-to-group --user-pool-id us-east-2_NsdZ4M0mj \
    --username gate-north@cameras.invalid --group-name CAMERA \
    --profile hotel --region us-east-2

# 5. Before building anything further: is Rekognition any good on THESE cameras?
aws rekognition detect-text \
    --image '{"S3Object":{"Bucket":"pacs-captures-dev","Name":"raw/gate-north/x.jpg"}}' \
    --profile hotel --region us-east-2 \
    --query 'TextDetections[?Type==`LINE`].[DetectedText,Confidence]' --output text
```

Step 5 is worth running against twenty real photographs of the gate **before** any of the
rest. If the plates do not appear there, the recommendation changes to a hosted ALPR API
and nothing built here is wasted — only the adapter.

### Two things that will bite

**An S3 trigger on a bucket the same stack creates is a circular dependency.** The bucket
needs the function's ARN for its `NotificationConfiguration`, the function's invoke
permission needs the bucket, and CloudFormation refuses the loop. Serverless' own `s3:`
event sidesteps it by creating the bucket itself, and then the lifecycle rules and
`DeletionPolicy: Retain` are lost, which is not acceptable for images that are evidence of
who entered the building. So the bucket is declared in `resources` with an explicit
notification, there is no `s3:` event on the function, and
`PlateRecognizerLambdaPermissionS3` carries a **literal** `SourceArn` string rather than
`!GetAtt CapturesBucket.Arn`. The bucket name is deterministic, so writing it out costs
nothing and removes the edge.

**`plateIngest` needs its event filter.** Without `filterPatterns` on
`pk: [{ prefix: 'plateread#' }]` the function wakes for every Cognito provisioning and
allocation event on the shared table, and pays for an RDS connection to discard each one.

## Layout

```
code/
+- apps/api/                    the backend service
|  +- serverless.yml            functions, events, Cognito, DynamoDB, S3, VPC endpoint
|  +- migrations/               node-pg-migrate, forward + down
|  +- scripts/                  seed, an end-to-end draw, and the offline stub API
|  +- src/
|     +- shared/                kernel: Result, errors, Clock, db, cache, http
|     +- modules/               one Clean Architecture ring set per module
|     |  +- allocation/         M-1: cycles, runs, the draw, waitlist
|     |  +- residents/          M-2
|     |  +- inventory/          M-3
|     |  +- fairness/           M-4: scores, history, metrics
|     |  +- identity/           M-6: JWT claims to Principal, RBAC
|     |  +- plates/             M-7: recognition, the gate log, access events
|     +- main/                  composition roots, the only place that calls `new`
+- apps/web/                    the Angular frontend
|  +- src/app/
|     +- core/                  OIDC config, auth store, guards, interceptors, errors
|     +- domain/                models + repository contracts as abstract classes
|     +- data/                  DTOs, mappers, HttpClient implementations
|     +- application/           signal facades with stale-while-revalidate
|     +- features/              lazy standalone pages
|     +- shared/ui/             status pill, five-state host, fairness explainer
+- packages/contracts/          OpenAPI 3.1, source for client types and mock servers
```

Each module has the same three rings and source dependencies point inward only:
`domain/` is pure TypeScript with no `async` and no I/O, `application/` knows only
ports, `infrastructure/` knows Kysely, DynamoDB, S3, Rekognition and Cognito. The draw is
therefore testable — and 10 000 times reproducible — without touching AWS, and so is the
whole plate decision table.

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

```powershell
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
pnpm --filter @pacs/api migrate:up      # the schema of section 11 plus M-7's three tables
pnpm --filter @pacs/api seed            # 24 residents, 10 spots, one open cycle
pnpm --filter @pacs/api exec tsx scripts/run-draw.ts
```

`run-draw.ts` is the integration layer of section 27, runnable by hand. It wires the real
repositories to the real use case and asserts the things only Postgres can prove:

```
PASS  run completes
PASS  every spot filled                                    assigned=10
PASS  remainder waitlisted                                 waitlisted=14
PASS  NFR-01: under 2 s
PASS  no resident assigned twice, no spot assigned twice
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

## Run the whole app offline

No AWS, no database, no deploy:

```bash
pnpm --filter @pacs/api local    # the stub API on http://localhost:4300
cd apps/web && pnpm start        # http://localhost:4200, signs in as admin@local
```

`scripts/local-api.mjs` is an in-memory implementation of the same contract
(`packages/contracts/openapi.yaml`), seeded with 72 residents, 56 bays, four periods, a
vehicle register, and a gate log with reads waiting in the review queue. It is a fixture
rather than a second implementation: when a shape there disagrees with the YAML, the YAML
wins and the stub is the bug. Its bearer token is `local.<base64url json>` with no
signature, accepted only by it — the deployed API rejects such a token at the Cognito
authorizer before any handler runs.

## Test and typecheck

```bash
pnpm --filter @pacs/api test        # 267 unit tests, including 10 000 seeded draws
pnpm --filter @pacs/api typecheck
```

The statistical suite is the unusual one and the reason it exists: it checks the raffle
is *fair*, not merely that it runs. The plate suite is the same argument applied to a
different problem — the whole threshold table, the Bolivian format scoring, the fuzzy
expansion and the scene blocklist are verified in milliseconds with no AWS, including the
regression that matters most: `VISITAS` canonicalises to `V1S1TAS`, the U/V confusable
pair expands that to `U1S1TAS`, and a string the blocklist has never heard of then scores
like a plate. The blocklist is therefore checked on the OCR line, before expansion.

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
node scripts/smoke.mjs               # post-deploy smoke set
```

### Two things that will bite on a fresh deploy

**Handler filenames must contain no dots.** The bundle is flattened, and the Node
runtime splits the handler string at the *first* dot — so `src/main/api.handler.ts` with
handler `src/main/api.handler.handler` fails at init with `Cannot find module 'api'`.
The files are therefore `api.ts`, `run-raffle.ts`, `sweeper.ts`, `plate-recognizer.ts`
and `plate-ingest.ts`. Section 10 of the document still shows the `*.handler.ts`
convention; it does not work.

**Reserved concurrency is impossible on a new account.** The Lambda quota starts at 10
concurrent executions and AWS requires 10 to stay unreserved, so any
`reservedConcurrency` fails the stack. The reservations of section 10 are commented out
with the reasoning; raise the quota, then restore them.

Serverless Framework v4 needs a vendor login in CI (`SERVERLESS_ACCESS_KEY`); it is
free for individuals and for organisations under the vendor's revenue threshold.
Confirm the licence terms before using it for a company account (ADR-011).

The stack creates: six functions (`api`, `runRaffle`, `sweeper`, `integrations`, and the
two M-7 ones, `plateRecognizer` and `plateIngest`), an HTTP API with a Cognito JWT
authorizer, a Cognito user pool with `ADMIN`/`RESIDENT`/`CAMERA` groups and a hosted login
domain, the `pacs-cache` and `pacs-events` DynamoDB tables, the `pacs-captures` bucket with
its lifecycle rules, two CloudWatch alarms, and a free DynamoDB gateway endpoint — which is
what removes the NAT gateway (ADR-016).

Outputs include `ApiBaseUrl`, `UserPoolId`, `UserPoolClientId`, `CognitoIssuer`,
`CognitoHostedUi` and `CapturesBucketName`; the Angular app needs the first five.

## Endpoints

The full contract is [`packages/contracts/openapi.yaml`](packages/contracts/openapi.yaml).
Every route except `GET /health` needs a bearer token. `{id}` parameters are UUIDs and
are rejected before they reach a query, so records cannot be enumerated.

| Method & path | Role | Purpose |
|---|---|---|
| `GET /health` | public | Liveness |
| `GET /me` | any | Principal profile, from the token only |
| `GET /me/dashboard` | resident | UC-09 aggregated status · cached 5 min |
| `GET /me/history` | resident | UC-10 own history |
| `POST /me/assignment/release` | resident | UC-11 give up a spot · promotes the waitlist |
| `GET /cycles/{id}/registrations` | admin | The period's entrants |
| `POST /cycles/{id}/registrations` | resident | UC-08 enter the raffle · idempotent |
| `DELETE /cycles/{id}/registrations/me` | any | Withdraw while registration is open |
| `GET` · `POST /residents` | admin | List · FR-10 create + provision Cognito user |
| `GET` · `PATCH` · `DELETE /residents/{id}` | admin | Detail · edit · soft delete |
| `PATCH /residents/{id}/eligibility` | admin | FR-15 · requires a reason |
| `GET` · `POST /residents/{id}/vehicles` | admin · own | The resident's registered plates |
| `PATCH` · `DELETE /residents/{id}/vehicles/{vehicleId}` | admin · own | Edit · remove (deactivate) |
| `GET /vehicles/by-plate/{plate}` | admin | Plate lookup for the gate · normalises first |
| `GET` · `POST /spots` | admin | FR-16 inventory |
| `PATCH /spots/{id}` | admin | Edit / deactivate · refuses if assigned |
| `DELETE /spots/{id}` | admin | Remove a bay never assigned |
| `GET /lots` | resident · admin | Levels with a bay in service |
| `GET /lots/{level}/occupancy` | resident · admin | Every bay on a level, its status and whether it is the viewer's |
| `GET` · `POST /cycles` | admin | UC-04 cycles |
| `POST /cycles/{id}/open-registration` | admin | DRAFT to REGISTRATION_OPEN |
| `POST /cycles/{id}/close-registration` | admin | Manual close |
| `POST /cycles/{id}/runs` | admin | UC-05 run · `Idempotency-Key` required |
| `GET /runs/{id}` | admin | Run detail + the seed, for audit |
| `GET /runs/{id}/assignments` | admin | Full result set |
| `GET /metrics/fairness` | admin | FR-22 dashboard · cached 10 min |
| `GET /reports/quarterly/{cycleId}` | admin | UC-07 export · `?format=csv` |
| `POST /captures` | **camera** · admin | M-7 presigned PUT for one frame · the key is derived server-side |
| `GET /plate-reads` | admin | The gate log, newest first · `?status= &cameraId= &plate= &from= &to=` |
| `GET /plate-reads/review` | admin | The review queue, **oldest** first |
| `GET /plate-reads/{id}` | admin | One read + its candidates + 5-minute image URLs |
| `POST /plate-reads/{id}/resolve` | admin | Review a read · `Idempotency-Key` required · 409 if already reviewed |
| `GET /access-events` | admin | The access log · `?decision= &residentId= &format=csv` |
| `GET /me/access-events` | resident | Own entries only, from the token · 403 for an admin |
| `GET /metrics/plates` | admin | Match rate, queue depth and age, correction count · cached 10 min |

Errors use one shape, with a `traceId` matching the log correlation id:

```json
{
  "error": "RAFFLE_IN_PROGRESS",
  "message": "An allocation run is already executing for this cycle.",
  "traceId": "7b4e...",
  "timestamp": "2026-03-26T02:00:00Z"
}
```

## Where this deviates from analysis.html rev 2.2

Each of these is a decision forced by the real account, not a design change. Section 10 of
the document still needs updating to match.

| Document says | Reality | Why |
|---|---|---|
| `us-east-1` | **`us-east-2`** | SCP `p-wvjo6arp` on account 309887812390 denies every other region |
| RDS PostgreSQL 17 | **18.3** | The existing `hotel-db` instance |
| Dedicated instance | Shares `hotel-db` | Reuses what exists; `pacs_dev` is its own database |
| Private subnets, no public access | **Publicly accessible**, SG open to one `/32` | Requested, so migrations and scripts can run from a laptop. Reverting is two commands, below |
| `migrate` Lambda in the VPC | Migrations run from a laptop or CI | Only needed while the database is unreachable from outside; put it back when access is closed |
| Per-function IAM roles via plugin | One scoped service role | Avoids a plugin whose v4 support is unverified. The statements are still resource-scoped with no wildcards, except `rekognition:DetectText` — the Rekognition operations that work without a collection have no ARNs to scope to, so it is scoped by action and said out loud in the file |
| Master DB password in SSM | **No database password at all** | IAM database authentication: a token signed locally per connection. Strictly better than section 10, and it is what its own security list asks for |
| `reservedConcurrency` api 10 / jobs 1-2 | None | Account quota is 10 concurrent executions; AWS requires 10 unreserved. The quota itself bounds the pool at 10 x 2 = 20 connections |
| `custom:resident_id` claim identifies the caller | Claim, else `sub`, else a pending link | Cognito puts custom attributes in the **ID token only**, and the API is called with an access token, so the claim is normally absent. The id still comes only from the verified token |
| Plate thresholds in `allocation_config` | Own `plate_config` table | The allocation module builds each new policy version from the one in force and lists its own columns, so threshold columns there would be reset to their defaults every time an administrator changed the period length |

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
pnpm start     # http://localhost:4200
pnpm build     # production bundle into dist/web
pnpm test      # 69 unit tests
```

| | |
|---|---|
| Angular | **22.2** — zoneless, standalone, signals, no zone.js |
| Components | **Angular Material 22.2**, with the project's own theme |
| Auth | `amazon-cognito-identity-js`, `USER_SRP_AUTH` from the product's own form · tokens in memory |
| Node | Angular 22 needs `^22.22.3 \|\| ^24.15.0 \|\| >=26` |

Lazy-loaded screens, so a resident never downloads the admin bundle:
`/` dashboard · `/lot` · `/history` · `/admin/residents` · `/admin/spots` ·
`/admin/draw` · `/admin/cycles` · `/admin/metrics` · `/admin/plates` · `/admin/reports`.

The rings mirror the backend's. `domain/` is plain TypeScript with no Angular import
beyond types; `data/` is the only place that knows `HttpClient` exists; facades expose
signals and own refetch, so pages stay presentational. The bindings live in one place,
`app.config.ts`, which is what makes a fake repository a one-line swap.

### Still missing on the frontend

- Transloco is installed but not wired. Section 17 requires Spanish and English
- Section 17 asks for the fairness explanation as a message key plus parameters so it can
  be translated. The API returns finished prose, so that one sentence cannot be localised
  without changing the contract — the one real design debt here. The plates module
  deliberately does not repeat it: `access_event.reason` is a stable code and the wording
  lives in `features/plates/reason-label.ts`

## Not built yet

- SES notification templates (M-5). `integrations` already receives the allocation
  events and logs them; only the templates and the send call are missing. **SES is in
  sandbox** (`ProductionAccessEnabled: false`, 200/day): it can only send to verified
  addresses until production access is requested
- The plate crop writer. `plate_read.crop_key`, the `crops/` IAM statement and the
  lifecycle rule all exist, but nothing writes a crop yet: cropping needs a native image
  decoder in the bundle, and the review screen reads the full frame instead
- Camera firmware. The browser capture page exists (`/gate`); nothing runs on a dedicated
  gate device
- Its own SES identity for Cognito. The default sender allows 50 emails a day for the
  account; the smoke suites spent it on 2026-10-14 (see the technical documentation §8.5)
- An on-failure destination on the `integrations` stream mapping: a failed provisioning is
  dropped after three retries
- The threshold calibration of MODULO-PLACAS.md section 8. The procedure and the storage
  exist; the week of shadow operation that produces real numbers has not happened, so
  0.85 and 0.55 are a starting point and are labelled as one
- A k6 load suite

Built since this list was first written: the git repository, the six GitHub Actions
checks, Playwright end-to-end tests, CodePipeline delivery to CloudFront, and the web
capture page. GitHub OIDC (ADR-018) is not possible — the organisation's SCP denies
identity providers — which is why delivery runs on CodePipeline.
