import { Injectable, inject } from '@angular/core';
import { LotRepository } from '../domain/repositories';
import { AuthStore } from '../core/auth/auth.store';
import type { BayOccupancy, BayStatus, LotLevel, BayPlacement } from '../domain/lot-layout';
import type { SpotType } from '../domain/models';

/**
 * A lot layout generated in the browser, standing in for `GET /lots/{id}/layout` until
 * the geometry tables exist server-side.
 *
 * It is a repository implementation rather than a fixture inside the page, so when the
 * endpoints land `app.config.ts` swaps one provider line and nothing above the data ring
 * changes. The shapes here are exactly the shapes the API will return.
 *
 * Bays are placed by a generator, never by hand: a hand-placed lot has to be redrawn
 * every time the building changes, and this same routine is what the admin screen will
 * call to lay out a new aisle.
 */

/**
 * The size of the lot.
 *
 * `totalBays` belongs with `allocationDuration` and `earlyWaitingBias` in the system
 * configuration an administrator edits -- it is a property of the building, not of the
 * code. It lives here only until that configuration endpoint exists; the generator
 * already treats it as an input, so moving it is a one-line change.
 */
export interface LotConfig {
  /** How many bays the building has in total. */
  readonly totalBays: number;
  /** How many bays fit along one aisle before a new one is started. */
  readonly baysPerRow: number;
}

export const DEFAULT_LOT_CONFIG: LotConfig = {
  totalBays: 56,
  baysPerRow: 14,
};

/* ----------------------------------------------------------------- geometry */

/** 1 user unit = 1 cm. A bay is 250 x 500 cm; the drive aisle between rows is 650. */
const BAY_W = 250;
const BAY_H = 500;
const BAY_GAP = 12;
const AISLE = 650;
/** Space between one pair of facing rows and the next. */
const BANK_GAP = 430;
/** The service strip on the left, carrying the lift core and the aisle letters. */
const LEFT_STRIP = 1150;
const MARGIN = 420;

const rowLetter = (row: number): string => String.fromCharCode(64 + row);

/**
 * Lays out `totalBays` as pairs of facing rows, which is how a real deck is arranged:
 * two ranks nose-in to each other with a drive aisle between them.
 */
const buildLevel = (
  levelId: string,
  label: string,
  order: number,
  config: LotConfig,
): LotLevel => {
  const perRow = Math.max(1, config.baysPerRow);
  const rowCount = Math.max(1, Math.ceil(config.totalBays / perRow));

  const bays: BayPlacement[] = [];
  let placed = 0;

  for (let row = 1; row <= rowCount; row++) {
    const remaining = config.totalBays - placed;
    if (remaining <= 0) break;
    const count = Math.min(perRow, remaining);

    // Rows pair up: the second of each pair faces back across the aisle.
    const pairIndex = Math.floor((row - 1) / 2);
    const isFarSide = (row - 1) % 2 === 1;
    const y =
      MARGIN + pairIndex * (2 * BAY_H + AISLE + BANK_GAP) + (isFarSide ? BAY_H + AISLE : 0);

    for (let col = 1; col <= count; col++) {
      bays.push({
        spotId: `${levelId}:${row}:${col}`,
        spotCode: `${levelId}-${rowLetter(row)}${String(col).padStart(2, '0')}`,
        levelId,
        zoneId: `${levelId}-${pairIndex === 0 ? 'NORTH' : pairIndex === 1 ? 'SOUTH' : 'EAST'}`,
        row,
        col,
        // A charging point at the head of each aisle, where the risers are.
        type: (col === 1 ? 'EV' : 'STANDARD') as SpotType,
        geometry: {
          x: LEFT_STRIP + (col - 1) * (BAY_W + BAY_GAP),
          y,
          w: BAY_W,
          h: BAY_H,
          rotation: isFarSide ? 180 : 0,
        },
      });
    }
    placed += count;
  }

  const maxX = Math.max(...bays.map((b) => b.geometry.x + b.geometry.w));
  const maxY = Math.max(...bays.map((b) => b.geometry.y + b.geometry.h));

  return {
    levelId,
    label,
    order,
    viewBox: { w: maxX + MARGIN, h: maxY + MARGIN },
    bays,
  };
};

/* --------------------------------------------------------------- occupancy */

/**
 * Deterministic pseudo-occupancy: a seeded hash of the bay rather than `Math.random`, so
 * a reload shows the same lot and a screenshot in a design review still matches what the
 * next person sees.
 */
const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // One more avalanche round: without it, ids differing in a single trailing character
  // land in neighbouring buckets and the lot fills in visible blocks.
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};

const NAMES: readonly (readonly [string, string])[] = [
  ['A. Rivera', '503'],
  ['M. Okonkwo', '211'],
  ['J. Lindqvist', '1104'],
  ['P. Marchetti', '308'],
  ['S. Haddad', '705'],
  ['L. Fontaine', '902'],
  ['D. Nakamura', '406'],
  ['K. Mbeki', '112'],
];

const statusFor = (r: number): BayStatus =>
  r < 0.05 ? 'OUT_OF_SERVICE' : r < 0.42 ? 'FREE' : 'HELD';

@Injectable()
export class SeedLotRepository extends LotRepository {
  private readonly config = DEFAULT_LOT_CONFIG;

  /**
   * This stand-in has to make the decision the real endpoint will make, and one of those
   * decisions is who may be named. It is read here rather than in the page because the
   * day `GET /lots/{id}/occupancy` lands, this whole class goes away and the omission has
   * to already live behind the repository contract, not in a template someone could
   * forget to copy.
   */
  private readonly auth = inject(AuthStore);

  private readonly levels_: readonly LotLevel[] = [
    buildLevel('B1', 'Level B1', -1, this.config),
  ];

  /** The bay this viewer holds, so the map can draw one as theirs. Null when none. */
  protected mine: string | null = 'B1:2:4';

  async levels(): Promise<readonly LotLevel[]> {
    return this.levels_;
  }

  async occupancy(levelId: string): Promise<readonly BayOccupancy[]> {
    const lvl = this.levels_.find((l) => l.levelId === levelId);
    if (!lvl) return [];

    const until = new Date();
    until.setMonth(until.getMonth() + 3);

    /*
     * Who holds a bay is an administrator's fact, not a resident's.
     *
     * A map that labels every bay with a name and a unit publishes the building's parking
     * register to everyone who can open it — which is also, bay by bay, who is away and
     * who is home. So the identity is dropped from the payload rather than hidden in the
     * view: it must not reach the client at all, because the map's accessible name, the
     * tooltip and the table all read it, and three places that each have to remember to
     * hide something is three places one can forget. The resident's own bay is not an
     * exception: `isMine` already marks it, so naming the occupant would add nothing.
     */
    const namesVisible = this.auth.isAdmin();

    return lvl.bays.map((b) => {
      const r = hash(`${b.spotId}#${b.spotCode}`);
      const status: BayStatus = b.spotId === this.mine ? 'HELD' : statusFor(r);
      const name = NAMES[Math.floor(r * NAMES.length) % NAMES.length]!;
      return {
        spotId: b.spotId,
        status,
        occupant:
          status !== 'HELD' || !namesVisible
            ? null
            : b.spotId === this.mine
              ? { displayName: 'You', unit: '604' }
              : { displayName: name[0], unit: name[1] },
        validUntil: status === 'HELD' ? until : null,
      };
    });
  }

  /** Exposed so the facade can mark one bay as the viewer's own while seeded. */
  mySpotId(): string | null {
    return this.mine;
  }
}
