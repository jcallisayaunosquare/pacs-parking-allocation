import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { CachePort } from '../../modules/allocation/application/ports';

/**
 * DynamoDB as the cache (ADR-017). Always free at this scale, reachable from inside the
 * VPC through a gateway endpoint — which is what removes the NAT gateway (ADR-016).
 *
 * Reads check `expiresAt` themselves: DynamoDB TTL deletion is lazy and can lag by
 * minutes, so trusting it alone would serve stale dashboards past their 5-minute budget.
 */
export class DynamoDbCache implements CachePort {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    client = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async get<T>(key: string): Promise<T | null> {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: key } }));
    const item = out.Item as { value?: T; expiresAt?: number } | undefined;
    if (!item?.value) return null;
    if (item.expiresAt !== undefined && item.expiresAt * 1000 < Date.now()) return null;
    return item.value;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: key,
          // The prefix is a separate attribute so invalidation can query a group
          // without a full table scan.
          prefix: key.split(':')[0] ?? 'misc',
          value,
          expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
        },
      }),
    );
  }

  /**
   * Event-driven invalidation (§20). An exact key is a point delete; a prefix walks the
   * GSI. Cache misses are always safe, so a partial failure is tolerable (ADR-007).
   */
  async invalidate(keyPrefix: string): Promise<void> {
    const exact = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: keyPrefix } }),
    );
    if (exact.Item) {
      await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: keyPrefix } }));
      return;
    }

    const group = keyPrefix.replace(/:$/, '').split(':')[0] ?? keyPrefix;
    const found = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: 'prefix-index',
        KeyConditionExpression: '#p = :p',
        ExpressionAttributeNames: { '#p': 'prefix' },
        ExpressionAttributeValues: { ':p': group },
        ProjectionExpression: 'pk',
      }),
    );

    await Promise.all(
      (found.Items ?? []).map((i) =>
        this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: i.pk } })),
      ),
    );
  }
}

/** Used in tests and local development; also the fallback when no table is configured. */
export class InMemoryCache implements CachePort {
  private readonly store = new Map<string, { value: unknown; expiresAt: number }>();

  async get<T>(key: string): Promise<T | null> {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return hit.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async invalidate(keyPrefix: string): Promise<void> {
    for (const k of [...this.store.keys()]) {
      if (k === keyPrefix || k.startsWith(keyPrefix)) this.store.delete(k);
    }
  }
}
