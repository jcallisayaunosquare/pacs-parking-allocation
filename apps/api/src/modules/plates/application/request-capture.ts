/**
 * `POST /captures`: hand the camera a presigned PUT and get out of the way.
 *
 * What this route deliberately does NOT do is recognise anything. A synchronous
 * `POST /plate-reads` that ran OCR would be an endpoint that takes 600 ms, holds an
 * in-VPC Lambda open while it waits on a service the VPC cannot reach, and fails whenever
 * the camera's uplink stutters mid-request. The path is always S3 first, then the object
 * notification - so the camera's job finishes when the bytes land, and recognition is
 * something that happens to the object afterwards.
 *
 * The key encodes camera and date: `raw/<cameraId>/<yyyy>/<mm>/<dd>/<captureId>.jpg`. It
 * is derived here rather than accepted from the client, because the client is a device in
 * a car park: letting it choose the key lets it write outside its own prefix, and the
 * IAM statement that scopes the role to `raw/*` would still allow it.
 */

import { fail } from '../../../shared/errors';
import { ok, type Result } from '../../../shared/result';
import type { Clock } from '../../../shared/clock';
import type { CaptureIdSource, CaptureStorage } from './ports';

/** Five minutes: a camera that cannot upload in five minutes has a different problem. */
export const UPLOAD_URL_TTL_SECONDS = 300;

export const CAMERA_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

const EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export interface CaptureRequest {
  readonly cameraId: string;
  readonly capturedAt: Date;
  readonly contentType: string;
}

export interface CaptureTicket {
  readonly captureId: string;
  readonly objectKey: string;
  readonly uploadUrl: string;
  readonly expiresIn: number;
}

export class RequestCapture {
  constructor(
    private readonly storage: CaptureStorage,
    private readonly ids: CaptureIdSource,
    private readonly clock: Clock,
    private readonly bucket: string | null,
  ) {}

  async execute(input: CaptureRequest): Promise<Result<CaptureTicket>> {
    if (this.bucket === null) {
      // No bucket configured is a deployment fault, not a caller fault, and it must not
      // be reported as a 400 that a camera operator would try to fix by retrying.
      return fail('INTERNAL_ERROR', 'Capture storage is not configured.');
    }

    if (!CAMERA_ID_PATTERN.test(input.cameraId)) {
      return fail('VALIDATION_FAILED', 'That is not a camera id.', [
        { field: 'cameraId', issue: 'lowercase letters, digits and hyphens, 3 to 64 characters' },
      ]);
    }

    const extension = EXTENSION_BY_TYPE[input.contentType];
    if (extension === undefined) {
      return fail('VALIDATION_FAILED', 'That image type is not accepted.', [
        { field: 'contentType', issue: 'must be image/jpeg or image/png' },
      ]);
    }

    /*
     * The frame is filed under the instant the SERVER saw it, not the one the camera
     * claims. A camera with a drifting clock would otherwise scatter its captures across
     * the wrong day prefixes and break the lifecycle rules and the day listings; the
     * camera's own timestamp is still carried into the row, where a skew is visible and
     * correctable instead of silently reorganising storage.
     */
    const at = this.clock.now();
    const captureId = this.ids.next(at);
    const yyyy = at.getUTCFullYear();
    const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(at.getUTCDate()).padStart(2, '0');
    const objectKey = `raw/${input.cameraId}/${yyyy}/${mm}/${dd}/${captureId}.${extension}`;

    const uploadUrl = await this.storage.presignUpload({
      bucket: this.bucket,
      key: objectKey,
      contentType: input.contentType,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });

    return ok({
      captureId,
      objectKey,
      uploadUrl,
      expiresIn: UPLOAD_URL_TTL_SECONDS,
    });
  }
}
