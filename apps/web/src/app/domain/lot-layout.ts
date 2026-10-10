/**
 * The lot map, as data.
 *
 * `parking_spot` carries no geometry, so a bay's position is a separate concern with its
 * own lifetime: inventory changes when the building changes, occupancy changes every
 * draw. The two are fetched apart and joined in the facade.
 *
 * Coordinates are integer centimetres in a per-level space whose origin is the level's
 * top-left corner, which is also the SVG user space. One number system from the floor
 * plan through to the rendered rect: no scaling factors scattered through the view.
 *
 * Pure TypeScript, like the rest of the domain ring. Nothing here knows about SVG,
 * Angular or HTTP -- the renderer is handed these shapes and draws them.
 */

import type { SpotType } from './models';

/** A bay's footprint. Rotation is the only reason this is not a CSS grid. */
export interface LotGeometry {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Degrees clockwise about the rect centre. 0 = long axis vertical, nose-in. */
  readonly rotation: number;
}

export interface BayPlacement {
  readonly spotId: string;
  readonly spotCode: string;
  readonly levelId: string;
  readonly zoneId: string | null;
  /**
   * The accessibility grid axes, authored rather than inferred. Deriving row membership
   * from `y` breaks the moment an aisle is staggered or angled, and a wrong row count
   * read out by a screen reader is worse than no row count at all.
   */
  readonly row: number;
  readonly col: number;
  readonly type: SpotType;
  readonly geometry: LotGeometry;
}

export interface LotLevel {
  readonly levelId: string;
  readonly label: string;
  /** Display order. Negative for below ground, so B2 sorts under B1. */
  readonly order: number;
  /** The SVG user-space box every geometry on this level is expressed in. */
  readonly viewBox: { readonly w: number; readonly h: number };
  readonly bays: readonly BayPlacement[];
}

/**
 * What the map shows for a bay. Derived at read time, never stored: the schema has
 * `parking_spot.is_active` and an assignment state, and this is the projection of those
 * two onto one value the renderer can draw.
 *
 *   is_active = false           -> OUT_OF_SERVICE
 *   an ACTIVE assignment exists -> HELD
 *   otherwise                   -> FREE
 *
 * There is deliberately no RESERVED. Nothing in the schema, the requirements or the
 * design backs it, and a bay held back by administration contradicts the premise that
 * every bay goes through the draw.
 */
export type BayStatus = 'FREE' | 'HELD' | 'OUT_OF_SERVICE';

export interface BayOccupancy {
  readonly spotId: string;
  readonly status: BayStatus;
  /**
   * Present only for an administrator. A map that labels every bay with a name and a
   * unit publishes the building's parking register to every resident, so the server
   * omits this field for a resident token rather than the client hiding it.
   */
  readonly occupant: { readonly displayName: string; readonly unit: string } | null;
  readonly validUntil: Date | null;
}

/** A placement joined to its current occupancy -- what the renderer actually draws. */
export interface Bay {
  readonly placement: BayPlacement;
  readonly status: BayStatus;
  readonly occupant: { readonly displayName: string; readonly unit: string } | null;
  readonly validUntil: Date | null;
  /** Drawn with the yellow boundary line, and the only bay worth interrupting for. */
  readonly isMine: boolean;
}

export const joinOccupancy = (
  level: LotLevel,
  occupancy: readonly BayOccupancy[],
  mySpotId: string | null,
): readonly Bay[] => {
  const byId = new Map(occupancy.map((o) => [o.spotId, o]));
  return level.bays.map((placement) => {
    const o = byId.get(placement.spotId);
    return {
      placement,
      status: o?.status ?? 'OUT_OF_SERVICE',
      occupant: o?.occupant ?? null,
      validUntil: o?.validUntil ?? null,
      isMine: mySpotId !== null && placement.spotId === mySpotId,
    };
  });
};

/* ------------------------------------------------------------------ rendering */

/**
 * The isometric toggle, as a projection rather than a renderer.
 *
 * A 30 deg dimetric matrix over the same x/y data is the whole of the "3D" effect, which is
 * why it costs about a kilobyte instead of the 170 kB of a WebGL engine -- and why the
 * accessibility tree survives it: the overlay is projected by the same matrix, so every
 * bay stays a real focusable element with a real name.
 */
export type Projection = 'plan' | 'isometric';

export const ISO_MATRIX = [0.866, 0.5, -0.866, 0.5] as const;

/** The projected bounds of a level, so the wrapper can size itself before paint. */
export const projectedViewBox = (
  level: LotLevel,
  projection: Projection,
): { x: number; y: number; w: number; h: number } => {
  const { w, h } = level.viewBox;
  if (projection === 'plan') return { x: 0, y: 0, w, h };

  const [a, b, c, d] = ISO_MATRIX;
  const xs = [0, a * w, c * h, a * w + c * h];
  const ys = [0, b * w, d * h, b * w + d * h];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
};

/**
 * Whether a bay is wide enough on screen to carry its own code.
 *
 * At map scale the stencilled code lands around 8 CSS px, which cannot pass SC 1.4.3 at
 * any colour. So below the threshold it is suppressed from the art and lives only in the
 * accessible name, the tooltip and the list -- which is also what keeps a zoomed-out
 * level from turning into grey noise.
 */
export const CODE_VISIBLE_AT_PX = 36;

export const showsCode = (bay: BayPlacement, userUnitsPerPx: number): boolean =>
  bay.geometry.w / userUnitsPerPx >= CODE_VISIBLE_AT_PX;

/* ----------------------------------------------------------------- navigation */

/**
 * Spatial arrow-key movement over the authored row/col axes.
 *
 * Deliberately not nearest-neighbour-by-distance: a screen reader announces "row 3,
 * column 7 of 12", and movement has to agree with what was announced or the two
 * interfaces describe different lots. Rows are ragged, so a column index is clamped
 * into the target row rather than skipped.
 */
export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
export type NavKey = ArrowKey | 'Home' | 'End' | 'PageUp' | 'PageDown';

const rowsOf = (bays: readonly BayPlacement[]): number[] =>
  [...new Set(bays.map((b) => b.row))].sort((a, b) => a - b);

const inRow = (bays: readonly BayPlacement[], row: number): BayPlacement[] =>
  bays.filter((b) => b.row === row).sort((a, b) => a.col - b.col);

/** Returns the spot id to focus next, or null when the key does not move. */
export const navigate = (
  bays: readonly BayPlacement[],
  fromSpotId: string,
  key: NavKey,
): string | null => {
  const from = bays.find((b) => b.spotId === fromSpotId);
  if (!from) return null;

  const rows = rowsOf(bays);
  const rowIndex = rows.indexOf(from.row);

  const step = (delta: number): string | null => {
    const target = rows[rowIndex + delta];
    if (target === undefined) return null;
    const siblings = inRow(bays, target);
    // Clamp rather than skip: aisles are ragged, and losing focus is worse than drifting.
    const landing = siblings.reduce((best, b) =>
      Math.abs(b.col - from.col) < Math.abs(best.col - from.col) ? b : best,
    );
    return landing.spotId;
  };

  const along = (delta: number): string | null => {
    const siblings = inRow(bays, from.row);
    const i = siblings.findIndex((b) => b.spotId === fromSpotId);
    return siblings[i + delta]?.spotId ?? null;
  };

  switch (key) {
    case 'ArrowUp':
      return step(-1);
    case 'ArrowDown':
      return step(1);
    case 'ArrowLeft':
      return along(-1);
    case 'ArrowRight':
      return along(1);
    case 'Home':
      return inRow(bays, from.row)[0]?.spotId ?? null;
    case 'End': {
      const siblings = inRow(bays, from.row);
      return siblings[siblings.length - 1]?.spotId ?? null;
    }
    case 'PageUp':
      return inRow(bays, rows[0]!)[0]?.spotId ?? null;
    case 'PageDown': {
      const last = inRow(bays, rows[rows.length - 1]!);
      return last[last.length - 1]?.spotId ?? null;
    }
  }
};

/**
 * Type-ahead on the bay code, because the real task on this screen is "find B2-14", and
 * arrowing 200 cells to reach it is not finding it. Separators are ignored so `b214`,
 * `B2-14` and `214` all land on the same bay.
 */
const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export const findByTypeAhead = (
  bays: readonly BayPlacement[],
  buffer: string,
): string | null => {
  const q = normalise(buffer);
  if (!q) return null;
  const hit =
    bays.find((b) => normalise(b.spotCode).startsWith(q)) ??
    bays.find((b) => normalise(b.spotCode).includes(q));
  return hit?.spotId ?? null;
};

/* --------------------------------------------------------------------- labels */

/**
 * The accessible name of a bay, as a key and parameters rather than a sentence -- section 17's
 * rule for every derived string, so translation is not string surgery.
 *
 * Order is fixed: code first, because it is the lookup key and someone scanning 200
 * cells needs the discriminator before the detail.
 */
export interface LabelSpec {
  readonly key: string;
  readonly params: Readonly<Record<string, string>>;
}

export const bayLabel = (bay: Bay, filteredOut = false): LabelSpec => {
  const { spotCode, type } = bay.placement;
  const base: Record<string, string> = { code: spotCode, type: type.toLowerCase() };

  const spec = (): LabelSpec => {
    if (bay.isMine)
      return {
        key: 'lot.bay.mine',
        params: { ...base, until: bay.validUntil?.toISOString() ?? '' },
      };
    switch (bay.status) {
      case 'FREE':
        return { key: 'lot.bay.free', params: base };
      case 'OUT_OF_SERVICE':
        return { key: 'lot.bay.closed', params: { code: spotCode } };
      case 'HELD':
        // The occupant is present only when the server decided the viewer may see it.
        return bay.occupant
          ? {
              key: 'lot.bay.heldBy',
              params: {
                ...base,
                name: bay.occupant.displayName,
                unit: bay.occupant.unit,
                until: bay.validUntil?.toISOString() ?? '',
              },
            }
          : { key: 'lot.bay.held', params: base };
    }
  };

  const s = spec();
  return filteredOut ? { key: `${s.key}.filtered`, params: s.params } : s;
};

/**
 * Until Transloco is wired, the English rendering lives beside the keys so the two
 * cannot drift. This is the only place in the map that produces prose.
 */
export const renderLabel = (spec: LabelSpec): string => {
  const p = spec.params;
  const until = p['until'] ? new Date(p['until']).toLocaleDateString() : '';
  const head = `${p['code']}, ${p['type'] ?? ''}`.replace(/, $/, '');
  const body = (() => {
    switch (spec.key.replace(/\.filtered$/, '')) {
      case 'lot.bay.mine':
        return `${head}, yours until ${until}`;
      case 'lot.bay.free':
        return `${head}, free`;
      case 'lot.bay.closed':
        return `${p['code']}, out of service`;
      case 'lot.bay.heldBy': {
        // The unit is dropped when it is absent rather than printed as an empty label:
        // "unit ," reads as a rendering fault, and this string is also what a screen
        // reader speaks, where a dangling "unit" is worse than no unit at all.
        const who = p['unit'] ? `${p['name']}, unit ${p['unit']}` : p['name'];
        return `${head}, occupied by ${who}, until ${until}`;
      }
      default:
        return `${head}, occupied`;
    }
  })();
  return spec.key.endsWith('.filtered') ? `${body}, filtered out` : body;
};

/* --------------------------------------------------------------------- filters */

export type LotFilter = 'ALL' | 'FREE' | 'HELD' | 'MINE' | 'EV';

export const matchesFilter = (bay: Bay, filter: LotFilter): boolean => {
  switch (filter) {
    case 'ALL':
      return true;
    case 'FREE':
      return bay.status === 'FREE';
    case 'HELD':
      return bay.status === 'HELD';
    case 'MINE':
      return bay.isMine;
    case 'EV':
      return bay.placement.type === 'EV';
  }
};

/** The one-line summary the live region announces after a filter or level change. */
export const summarise = (bays: readonly Bay[]): string => {
  const free = bays.filter((b) => b.status === 'FREE').length;
  return `${bays.length} bays, ${free} free.`;
};
