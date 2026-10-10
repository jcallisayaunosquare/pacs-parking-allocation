import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { PlateEventPublisher, PlateRecognizedEvent } from '../application/ports';

/**
 * `pacs-events`, as the bridge across the VPC boundary.
 *
 * The recogniser runs outside the VPC, so it can reach S3 and Rekognition and cannot
 * reach Postgres. `plateIngest` runs inside, so the reverse. The item written here, and
 * the stream the table already has, is the join - the same pattern the Cognito
 * provisioning flow uses, with the direction reversed.
 *
 * The partition key is `plateread#<captureId>`, so a retried S3 notification overwrites
 * one item rather than appending a second event. The TTL is fourteen days: long enough
 * that a broken consumer can be fixed and the stream replayed, short enough that nobody
 * mistakes this table for the durable record. The durable record is Postgres.
 */
const DEFAULT_TTL_SECONDS = 14 * 24 * 3600;

export class DynamoPlateEventPublisher implements PlateEventPublisher {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    client = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  private pk(captureId: string): string {
    return `plateread#${captureId}`;
  }

  async alreadyPublished(captureId: string): Promise<boolean> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: this.pk(captureId) },
        ProjectionExpression: 'pk',
        // Strongly consistent, because the thing being avoided is paying for a second
        // Rekognition call and an eventually consistent read can miss the first one.
        ConsistentRead: true,
      }),
    );
    return r.Item !== undefined;
  }

  async publishIfAbsent(
    event: PlateRecognizedEvent,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk: this.pk(event.captureId),
            type: 'PlateRecognized',
            ...event,
            expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
          },
          // This is the real guarantee. The GetItem above is an optimisation that saves a
          // Rekognition call; the condition is what makes a concurrent retry a no-op.
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
}

/** Used in tests and when no table is configured. */
export class InMemoryPlateEventPublisher implements PlateEventPublisher {
  readonly published = new Map<string, PlateRecognizedEvent>();

  async alreadyPublished(captureId: string): Promise<boolean> {
    return this.published.has(captureId);
  }

  async publishIfAbsent(event: PlateRecognizedEvent): Promise<boolean> {
    if (this.published.has(event.captureId)) return false;
    this.published.set(event.captureId, event);
    return true;
  }
}
