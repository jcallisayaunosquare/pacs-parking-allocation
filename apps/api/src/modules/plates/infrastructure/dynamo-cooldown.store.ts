import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { CooldownStore } from '../application/ports';

/**
 * The dedupe window, on `pacs-cache` with its TTL attribute.
 *
 * The idea is CarVision's; the store is the right one for this stack. CarVision keeps the
 * window in process memory, which works for one long-lived process and fails here for two
 * reasons: a Lambda container is replaced without warning, and several containers run at
 * once, so an in-memory window is per container and the duplicate it was meant to stop
 * arrives in the next one. `pacs-cache` is already reachable from inside the VPC through
 * the free DynamoDB gateway endpoint, so this costs nothing new.
 *
 * Keyed on `(cameraId, plate)` and not on the plate alone: the same car entering by the
 * north gate and leaving by the south are two facts, and collapsing them would lose the
 * exit.
 *
 * Reads check `expiresAt` themselves, like `DynamoDbCache` does, because DynamoDB's TTL
 * deletion is lazy and can lag by minutes - long enough to swallow a second genuine
 * arrival if the lag were trusted.
 */
export class DynamoCooldownStore implements CooldownStore {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    client = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  private key(cameraId: string, plate: string): string {
    return `platecooldown#${cameraId}#${plate}`;
  }

  async check(cameraId: string, plate: string): Promise<boolean> {
    const out = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: this.key(cameraId, plate) },
        ProjectionExpression: 'expiresAt',
        // Strongly consistent: the whole point is to catch a write made one second ago by
        // another container, and an eventually consistent read can miss exactly that.
        ConsistentRead: true,
      }),
    );
    const item = out.Item as { expiresAt?: number } | undefined;
    if (item === undefined) return false;
    return item.expiresAt === undefined || item.expiresAt * 1000 >= Date.now();
  }

  async mark(cameraId: string, plate: string, ttlSeconds: number): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: this.key(cameraId, plate),
          // The same grouping attribute `DynamoDbCache` writes, so a prefix invalidation
          // can clear the windows without scanning the table.
          prefix: 'platecooldown',
          expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
        },
      }),
    );
  }
}

/** Used in tests and when no table is configured. The window is per process, and says so. */
export class InMemoryCooldownStore implements CooldownStore {
  private readonly store = new Map<string, number>();

  async check(cameraId: string, plate: string): Promise<boolean> {
    const until = this.store.get(`${cameraId}#${plate}`);
    if (until === undefined) return false;
    if (until < Date.now()) {
      this.store.delete(`${cameraId}#${plate}`);
      return false;
    }
    return true;
  }

  async mark(cameraId: string, plate: string, ttlSeconds: number): Promise<void> {
    this.store.set(`${cameraId}#${plate}`, Date.now() + ttlSeconds * 1000);
  }
}
