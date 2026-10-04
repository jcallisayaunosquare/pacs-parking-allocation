/**
 * Fenwick (binary indexed) tree over integer weights.
 *
 * Gives the weighted draw without replacement its O(k log n): each winner costs one
 * O(log n) search plus one O(log n) update to zero that entrant's weight, instead of
 * rebuilding a cumulative array per pick (§12).
 *
 * Weights are integers on purpose — fairness scores are numeric(10,2) in the database,
 * so callers scale by 100 before constructing. Integer arithmetic keeps the draw exactly
 * reproducible; summing floats in a different order would not be.
 */
export class FenwickTree {
  private readonly tree: number[];
  private readonly size: number;

  constructor(weights: readonly number[]) {
    this.size = weights.length;
    this.tree = new Array<number>(this.size + 1).fill(0);
    for (let i = 0; i < this.size; i++) {
      const w = weights[i] ?? 0;
      if (!Number.isInteger(w) || w < 0) {
        throw new RangeError(`FenwickTree needs non-negative integer weights, got ${w} at ${i}`);
      }
      this.add(i, w);
    }
  }

  /** Adds delta to the weight at index i. */
  add(i: number, delta: number): void {
    for (let p = i + 1; p <= this.size; p += p & -p) {
      this.tree[p] = (this.tree[p] ?? 0) + delta;
    }
  }

  /** Sum of weights in [0, i]. */
  prefixSum(i: number): number {
    let s = 0;
    for (let p = i + 1; p > 0; p -= p & -p) s += this.tree[p] ?? 0;
    return s;
  }

  get total(): number {
    return this.prefixSum(this.size - 1);
  }

  /**
   * Smallest index whose prefix sum is strictly greater than `target`.
   * `target` must be in [0, total) — the caller draws it from the Rng.
   */
  findByCumulativeWeight(target: number): number {
    let idx = 0;
    let remaining = target;
    // Walk down the tree from the highest power of two <= size.
    let bit = 1;
    while (bit << 1 <= this.size) bit <<= 1;
    for (; bit > 0; bit >>= 1) {
      const next = idx + bit;
      if (next <= this.size && (this.tree[next] ?? 0) <= remaining) {
        remaining -= this.tree[next] ?? 0;
        idx = next;
      }
    }
    return idx;
  }

  /** Current weight at index i. */
  weightAt(i: number): number {
    return this.prefixSum(i) - (i > 0 ? this.prefixSum(i - 1) : 0);
  }
}
