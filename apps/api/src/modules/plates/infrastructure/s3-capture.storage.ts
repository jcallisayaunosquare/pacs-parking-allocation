import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { CaptureMetadata, CaptureStorage } from '../application/ports';

/**
 * S3: the frames, and the presigned URLs at both ends of their life.
 *
 * Thin on purpose. The interesting code is in `domain/`, and that is the point of the
 * ring boundary: the part worth testing has no AWS in it.
 */
export class S3CaptureStorage implements CaptureStorage {
  constructor(private readonly client: S3Client = new S3Client({})) {}

  async head(bucket: string, key: string): Promise<CaptureMetadata> {
    const r = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const meta = r.Metadata ?? {};

    /*
     * S3 lowercases user metadata keys, always. Reading `x-amz-meta-Camera-Id` back as
     * `Camera-Id` returns undefined and the event silently loses its camera - which then
     * shows up as every read in the log attributed to a camera called "unknown".
     */
    return {
      // No metadata means the object did not come through POST /captures - somebody put
      // it there with the CLI during an incident, say. The key is the fallback identity,
      // so the frame is still processed rather than dropped.
      captureId: meta['capture-id'] ?? captureIdFromKey(key),
      cameraId: meta['camera-id'] ?? cameraIdFromKey(key),
      capturedAt: meta['captured-at'] ?? (r.LastModified ?? new Date()).toISOString(),
      sizeBytes: r.ContentLength ?? 0,
      contentType: r.ContentType ?? null,
    };
  }

  /**
   * The upload URL handed to the camera.
   *
   * `ContentType` is part of what is signed, so the camera cannot upload a 40 MB video
   * under a key the pipeline will try to read as a JPEG. The size ceiling is enforced on
   * the way out instead, by `HeadObject` in the recogniser: a presigned PUT can carry a
   * content-length condition only as a POST policy, and switching the camera client to a
   * multipart POST to gain that is a worse trade than one HeadObject per capture.
   */
  async presignUpload(input: {
    bucket: string;
    key: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        ContentType: input.contentType,
      }),
      { expiresIn: input.expiresInSeconds },
    );
  }

  /** The review screen's read URL. Short-lived: the API never serves an image itself. */
  async presignDownload(input: {
    bucket: string;
    key: string;
    expiresInSeconds: number;
  }): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
      { expiresIn: input.expiresInSeconds },
    );
  }
}

/** `raw/<cameraId>/<yyyy>/<mm>/<dd>/<captureId>.jpg` */
export const captureIdFromKey = (key: string): string =>
  (key.split('/').pop() ?? key).replace(/\.[a-z0-9]+$/i, '');

export const cameraIdFromKey = (key: string): string => key.split('/')[1] ?? 'unknown';
