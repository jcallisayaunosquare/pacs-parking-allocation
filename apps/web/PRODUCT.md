# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## What this is

PACS allocates a residential building's parking bays to its residents on a recurring
draw. Bays rotate on a configurable period (three months initially). Residents register
for a period; when registration closes an administrator runs the allocation, and every
bay is assigned by a stated fairness policy rather than by discretion or by who asked
first.

## Users and jobs

Two roles, confirmed as equally important; neither half of the product is secondary.

**Resident** - visits rarely, a few times per period. Their jobs:
- register for the coming draw, or withdraw;
- find out whether they were allocated a bay, and which one;
- see where that bay is in the building;
- release a bay they no longer need;
- understand why they did or did not get one.

**Administrator** - visits often, works in the product. Their jobs:
- maintain the register of residents and the inventory of bays;
- open and close registration, and run the allocation;
- set the allocation policy values;
- answer a resident who is contesting a result;
- export the record of a period.

## Mechanism, and what is different about it

The allocation is a **deterministic total order with a verifiable draw as the tie-break**,
not a lottery:

1. longest current waiting time wins;
2. on a tie, fewest past allocations wins;
3. on a remaining exact tie, a seeded draw decides.

Waiting time is computed from stored timestamps and never stored as a counter, so it
cannot drift or be edited. The draw token for each resident is
`sha256(seed:runId:residentId)`, which means a resident can recompute their own token and
check it. Each run records the policy values in force, the candidate list, every computed
key and the seed, so any past result can be explained and re-derived.

An administrator never holds a bay and never enters the draw: separation of duties,
because they operate it.

## Durable constraints

- **Angular Material is the component library.** Confirmed to stay. The theme may be
  replaced entirely; the library may not.
- **WCAG 2.2 AA is non-negotiable**, including where it constrains visual decisions.
  Measured contrast, full keyboard operation, screen-reader support. SC 2.5.8 target size
  governs the lot map on small screens.
- **The graphical lot map stays.** It may be restyled, not removed. Bays are drawn to
  scale from layout data; selecting one opens its detail. It carries a parallel DOM layer
  because a canvas has no accessibility tree.
- Bilingual ES/EN is planned via Transloco; derived strings are message keys plus
  parameters, never assembled prose.
- Policy values (`allocationDuration`, `earlyWaitingBias`, `waitQuantum`, `totalBays`) are
  administrator-editable and versioned. No policy number is hardcoded.

## Terminology

Bay (not "spot" in the UI), period, draw, register, waiting time, allocation history,
eligibility. "Remove" a resident, never "delete": the allocation history is never reset,
because past draws must stay explainable.

## Context and evaluation

This is built as a promotion assessment, judged by Unosquare evaluators rather than
shipped to a building. The brief states the emphasis is on demonstrating senior-level
thinking rather than on delivering working code. The product must still read as credible
and finished: the evaluators are engineers and technical leads, so unexplained choices,
inconsistent surfaces and decorative accessibility claims cost more than missing features.

## Open

- Whether accessible-bay handling stays in the product; it exists in the schema and the
  allocation pre-pass, and was removed from the map view only.
- Reactivation policy for a resident who leaves and returns (`absenceResetMonths` is
  stored and validated but has no trigger).
