import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../../shared/clock';
import { fixedCaptureIdSource } from '../infrastructure/ulid-capture-id.source';
import { RequestCapture, UPLOAD_URL_TTL_SECONDS } from './request-capture';
import type { CaptureMetadata, CaptureStorage } from './ports';

const CLOCK = fixedClock('2026-10-09T14:03:11Z');
const CAPTURE_ID = '01JB3K5Z9Q7M2N4P6R8T0V2X4Y';

const storage = (): CaptureStorage & { signed: { key: string; contentType: string }[] } => {
  const signed: { key: string; contentType: string }[] = [];
  return {
    signed,
    async head(): Promise<CaptureMetadata> {
      throw new Error('not used');
    },
    async presignUpload(input) {
      signed.push({ key: input.key, contentType: input.contentType });
      return `https://s3.example/${input.key}?sig=1`;
    },
    async presignDownload() {
      return 'https://s3.example/read';
    },
  };
};

const build = (bucket: string | null = 'pacs-captures-dev') => {
  const s = storage();
  return {
    s,
    uc: new RequestCapture(s, fixedCaptureIdSource(CAPTURE_ID), CLOCK, bucket),
  };
};

describe('RequestCapture', () => {
  it('derives the key from the camera and the server’s own date', () => {
    // The key is never taken from the client: the client is a device in a car park, and
    // letting it name the key lets it write outside the prefix the IAM statement scopes.
    const { uc, s } = build();
    return uc
      .execute({
        cameraId: 'gate-north',
        capturedAt: new Date('2026-01-01T00:00:00Z'),
        contentType: 'image/jpeg',
      })
      .then((r) => {
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        // The camera claimed January; the server knows it is October. The frame is filed
        // under the server's day, so a drifting camera clock cannot scatter captures
        // across the wrong lifecycle prefixes.
        expect(r.value.objectKey).toBe(
          `raw/gate-north/2026/10/09/${CAPTURE_ID}.jpg`,
        );
        expect(r.value.captureId).toBe(CAPTURE_ID);
        expect(r.value.expiresIn).toBe(UPLOAD_URL_TTL_SECONDS);
        expect(s.signed[0]?.contentType).toBe('image/jpeg');
      });
  });

  it('uses the right extension for a PNG', async () => {
    const { uc } = build();
    const r = await uc.execute({
      cameraId: 'gate-south',
      capturedAt: CLOCK.now(),
      contentType: 'image/png',
    });
    expect(r.ok && r.value.objectKey.endsWith('.png')).toBe(true);
  });

  it('refuses a content type the pipeline cannot read', async () => {
    const { uc } = build();
    const r = await uc.execute({
      cameraId: 'gate-north',
      capturedAt: CLOCK.now(),
      contentType: 'video/mp4',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.[0]?.field).toBe('contentType');
  });

  it('refuses a camera id that would escape its own prefix', async () => {
    const { uc } = build();
    for (const cameraId of ['../other', 'Gate North', 'a', '']) {
      const r = await uc.execute({
        cameraId,
        capturedAt: CLOCK.now(),
        contentType: 'image/jpeg',
      });
      expect(r.ok).toBe(false);
    }
  });

  it('reports a missing bucket as a deployment fault, not a caller error', async () => {
    // A 400 would have a camera operator retrying for ever against a stack that is
    // simply missing an environment variable.
    const { uc } = build(null);
    const r = await uc.execute({
      cameraId: 'gate-north',
      capturedAt: CLOCK.now(),
      contentType: 'image/jpeg',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INTERNAL_ERROR');
  });
});
