# Web

The Angular 22 front end. What it is and who it is for is in [`PRODUCT.md`](PRODUCT.md);
the direction it is built to is in
[`.impeccable/surfaces/src-app.md`](.impeccable/surfaces/src-app.md). This file is only
how to run it.

## Run it against the deployed stack — the default

```bash
cd apps/web
pnpm start                      # ng serve, http://localhost:4200
```

`environment.ts` points at the deployed `dev` API and the real user pool, and the sign-in
form is ours (SRP, `core/auth/cognito.service.ts`), so there is no hosted-UI round trip.
Sign in with a real Cognito account.

This is the default on purpose. A screen can look finished against a fake while the
endpoint behind it does not exist, and the **gate camera** cannot be exercised against a
stub at all: the recognition path is S3 → Rekognition → DynamoDB stream → Postgres, and
there is nothing meaningful to stand in for it.

### The gate

`/gate` is the whole of M-7 on one screen. It opens a camera with `getUserMedia`, scales
each frame, asks the API for a presigned PUT and sends the bytes straight to S3; an
administrator also gets the arrival it produced — plate, resident, unit, car, bay, and
whether that car has parking — and the full log underneath. A CAMERA account gets the
capture half only: the verdict names a resident and their car, and the device running it
is bolted to a wall in a car park.

Three capture modes, all ending at the same presigned PUT — the recogniser cannot tell
which one a frame came from:

- **Continuous** — a frame every few seconds, unattended. Frames too blurred to read
  anything from are not sent at all.
- **On demand** — nothing is sent until the operator presses. One press takes a short
  burst and uploads only the sharpest frame of it, so one arrival is one capture.
- **Captured** — no camera. A photograph that already exists is dropped in and read: a
  frame off a DVR, a picture from a phone, evidence sent after the fact. Anything that is
  not JPEG or PNG, or is larger than about 2.5 MB, is re-encoded in the browser first.

Both are gated on a focus measurement taken in the browser (the variance of the Laplacian
on a small grey copy of the frame), which is what the meter under the preview shows.
Continuous exists for a lane that runs by itself; on demand exists because the cooldown
keeps the first decided frame of a car, and the first frame is the one taken while it was
still entering the lane.

It needs a CAMERA account, one per lane:

```bash
cd apps/api
GATE_PASSWORD='…' pnpm gate-user gate-main
```

The browser only grants camera access on a secure origin, which `http://localhost` counts
as. A device reached by IP address does not, so a gate on the building's network needs
HTTPS.

## Run it offline, with no AWS

Two processes, and an explicit flag. The `offline` configuration swaps in
`environment.offline.ts`, which points at `http://localhost:4300` and switches on the
offline sign-in stub.

```bash
# terminal 1 - the API, in memory
cd apps/api
pnpm local                      # node scripts/local-api.mjs, listens on 4300

# terminal 2 - the app
cd apps/web
pnpm offline                    # ng serve --configuration offline
```

Sign in with **any password** as:

| Email | Role |
|---|---|
| `admin@local` | building administrator |
| `resident@local` | a resident who holds a bay and is entered for the coming period |

The stub seeds 72 residents, 56 bays (`B1-A01` … `B1-D14`, the same codes the lot plan
generates), four periods around today, and a vehicle register. Everything it holds lives
in the process: restart it and the building is new again. It implements the shapes in
`packages/contracts/openapi.yaml` and nothing else — when the two disagree, the contract
is right and the stub is the bug.

**None of it reaches a deployed build.** `environment.localAuth` is true only in
`environments/environment.offline.ts`, which no other configuration loads, and the token
the stub mints (`local.<base64url json>`, unsigned) is refused by the real API at the
Cognito authorizer before any handler sees it.

## The usual commands

```bash
pnpm start                      # dev server on 4200, against the deployed stack
pnpm offline                    # dev server on 4200, against the in-memory stub
pnpm build                      # production build, into dist/
pnpm test                       # vitest, through the Angular builder
npx ng build --configuration development   # the quick type-and-template check
```

`scripts/capture-screens.mjs` and `scripts/diagnose-login.mjs` drive a real browser
against the **deployed** stack and need AWS credentials, a `DATABASE_URL` and Playwright
browsers. They are not part of the offline loop above.
