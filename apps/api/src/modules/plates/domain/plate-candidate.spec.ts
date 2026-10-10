import { describe, expect, it } from 'vitest';
import { fuseConfidence, rankCandidates } from './plate-candidate';
import { estimateQuality } from './plate-quality';

describe('rankCandidates', () => {
  it('picks the plate out of a frame full of signage', () => {
    // This is the whole job: Rekognition reads everything in the frame, and the format
    // table plus the blocklist are what turn that into one plate.
    const ranked = rankCandidates([
      { text: 'PARQUEO', confidence: 0.98 },
      { text: 'VISITAS', confidence: 0.95 },
      { text: '1234 ABC', confidence: 0.91 },
    ]);
    expect(ranked[0]?.plate).toBe('1234ABC');
  });

  it('surfaces the corrected variant above the raw mis-read', () => {
    const ranked = rankCandidates([{ text: '1234A8C', confidence: 0.88 }]);
    // 1234ABC matches UNICA_4_3 (+100); 1234A8C matches nothing. The raw line is kept
    // beside it, because audit needs what the camera actually said.
    expect(ranked[0]?.plate).toBe('1234ABC');
    expect(ranked[0]?.raw).toBe('1234A8C');
  });

  it('gives every variant of a line that line’s own confidence', () => {
    const ranked = rankCandidates([{ text: '1234A8C', confidence: 0.88 }]);
    // The engine was 0.88 sure of the pixels, not of our re-spelling of them. What
    // separates the variants is the score, not an invented confidence.
    expect(ranked.every((c) => c.confidence === 0.88)).toBe(true);
  });

  it('cannot let a scene word escape through variant expansion', () => {
    /*
     * The regression this module's scaffold found, and the reason the blocklist is
     * checked on the LINE rather than on each variant.
     *
     * "VISITAS" canonicalises to V1S1TAS (I folds to 1). The U/V confusable pair then
     * expands that to U1S1TAS - seven characters, digits and letters, not in the
     * blocklist - which scores like a plate and would be offered to the gate as one.
     */
    expect(rankCandidates([{ text: 'VISITAS', confidence: 0.99 }])).toEqual([]);
    expect(rankCandidates([{ text: 'PARQUEO', confidence: 0.99 }])).toEqual([]);
    expect(rankCandidates([{ text: 'PARQUEO PRIVADO', confidence: 0.99 }])).toEqual([]);
  });

  it('returns nothing for a frame with no alphanumeric text at all', () => {
    expect(rankCandidates([{ text: '---', confidence: 0.99 }])).toEqual([]);
    expect(rankCandidates([])).toEqual([]);
  });

  it('honours the limit so the stored candidate list stays bounded', () => {
    const ranked = rankCandidates(
      [
        { text: '1234ABC', confidence: 0.9 },
        { text: '5678BCD', confidence: 0.9 },
        { text: '9876ZYX', confidence: 0.9 },
      ],
      { limit: 2 },
    );
    expect(ranked).toHaveLength(2);
  });

  it('respects an overridden blocklist', () => {
    expect(
      rankCandidates([{ text: '1234ABC', confidence: 0.99 }], { blocklist: ['1234ABC'] }),
    ).toEqual([]);
  });
});

describe('fuseConfidence', () => {
  it('leaves the confidence alone when there is no quality signal', () => {
    // Inventing a neutral 0.5 would silently penalise every frame the engine gave us no
    // geometry for.
    expect(fuseConfidence(0.9, null)).toBe(0.9);
  });

  it('never exceeds the OCR confidence and never zeroes it', () => {
    expect(fuseConfidence(0.9, 1)).toBeCloseTo(0.9, 10);
    // Quality can only take away, and at most 40%.
    expect(fuseConfidence(0.9, 0)).toBeCloseTo(0.54, 10);
    expect(fuseConfidence(0.9, 0.5)).toBeLessThan(0.9);
  });

  it('clamps inputs rather than trusting an adapter', () => {
    expect(fuseConfidence(1.4, 2)).toBeLessThanOrEqual(1);
    expect(fuseConfidence(-1, -1)).toBe(0);
  });
});

describe('estimateQuality', () => {
  it('rises with the plate’s pixel height, which is the dominant term', () => {
    const low = estimateQuality({ pixelHeight: 14, aspect: 3, lineConfidences: [0.9] });
    const high = estimateQuality({ pixelHeight: 60, aspect: 3, lineConfidences: [0.9] });
    expect(high).toBeGreaterThan(low);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(1);
  });

  it('scores a sign-shaped box below a plate-shaped one', () => {
    const plate = estimateQuality({ pixelHeight: 40, aspect: 3, lineConfidences: [0.9] });
    const banner = estimateQuality({ pixelHeight: 40, aspect: 12, lineConfidences: [0.9] });
    expect(plate).toBeGreaterThan(banner);
  });

  it('treats one clear winner among noisy lines as a good sign', () => {
    const winner = estimateQuality({
      pixelHeight: 40,
      aspect: 3,
      lineConfidences: [0.99, 0.4, 0.4],
    });
    const flat = estimateQuality({
      pixelHeight: 40,
      aspect: 3,
      lineConfidences: [0.6, 0.6, 0.6],
    });
    expect(winner).toBeGreaterThan(flat);
  });
});
