/**
 * Geometry for the map: bay corners, the isometric projection, and the overlay boxes.
 *
 * Pure functions over numbers, deliberately separate from the renderer, because this is
 * the part that is worth unit-testing and the part a canvas or WebGL renderer would need
 * verbatim if the view layer were ever replaced.
 */

import { ISO_MATRIX, type LotGeometry, type LotLevel, type Projection, projectedViewBox } from './lot-layout';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The four corners of a bay in level space, in draw order, honouring its rotation. */
export const corners = (g: LotGeometry): readonly Point[] => {
  const cx = g.x + g.w / 2;
  const cy = g.y + g.h / 2;
  const rad = (g.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = g.w / 2;
  const hh = g.h / 2;
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([dx, dy]) => ({
    x: cx + dx! * cos - dy! * sin,
    y: cy + dx! * sin + dy! * cos,
  }));
};

export const project = (p: Point, projection: Projection): Point => {
  if (projection === 'plan') return p;
  const [a, b, c, d] = ISO_MATRIX;
  return { x: a * p.x + c * p.y, y: b * p.x + d * p.y };
};

/** An SVG `points` attribute for a bay's floor face. */
export const facePoints = (g: LotGeometry, projection: Projection, origin: Point): string =>
  corners(g)
    .map((p) => project(p, projection))
    .map((p) => `${(p.x - origin.x).toFixed(1)},${(p.y - origin.y).toFixed(1)}`)
    .join(' ');

/**
 * The extruded side face that reads as thickness in the isometric view. One quad per bay
 * rather than a mesh: the illusion only needs the two edges facing the viewer, and this is
 * the whole cost of the "3D" look -- about a kilobyte, against 170 for a WebGL engine.
 */
export const KERB = 14;

export const sidePoints = (g: LotGeometry, origin: Point): string => {
  const pts = corners(g).map((p) => project(p, 'isometric'));
  // The near edge is the one with the greatest projected y.
  const sorted = [...pts].sort((p, q) => q.y - p.y);
  const [n1, n2] = [sorted[0]!, sorted[1]!];
  const quad = [n1, n2, { x: n2.x, y: n2.y + KERB }, { x: n1.x, y: n1.y + KERB }];
  return quad.map((p) => `${(p.x - origin.x).toFixed(1)},${(p.y - origin.y).toFixed(1)}`).join(' ');
};

export interface OverlayBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The hit and semantics box for a bay, as percentages of the projected viewBox.
 *
 * In plan view this is the bay exactly. In the isometric view it is the bounding box of
 * the projected parallelogram, so the hit area is slightly generous at the corners -- an
 * acceptable trade, because the alternative is a `clip-path` per bay, and a focus ring
 * that follows a sheared outline is harder to see than one that does not.
 */
export const overlayBox = (
  g: LotGeometry,
  projection: Projection,
  level: LotLevel,
): OverlayBox => {
  const box = projectedViewBox(level, projection);
  const pts = corners(g).map((p) => project(p, projection));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    left: ((minX - box.x) / box.w) * 100,
    top: ((minY - box.y) / box.h) * 100,
    width: ((Math.max(...xs) - minX) / box.w) * 100,
    height: ((Math.max(...ys) - minY) / box.h) * 100,
  };
};
