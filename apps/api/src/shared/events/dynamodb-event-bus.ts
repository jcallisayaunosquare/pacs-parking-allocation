import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DomainEvent } from '../../modules/allocation/application/ports';

/**
 * The event bus of §10: `pacs-events` plus its stream. Reachable from inside the VPC
 * through the free DynamoDB gateway endpoint, which is what lets internet-bound work
 * run in `integrations` outside the VPC with no NAT gateway (ADR-016).
 *
 * Two kinds of item share the table:
 *   `evt#<uuid>`   a domain event, fanned out by the stream
 *   `link#<sub>`   a Cognito subject → resident mapping, written by integrations
 *                  because that function has no route to the database
 */
const EVENT_TTL_DAYS = 7;
const LINK_TTL_DAYS = 30;

const ttl = (days: number): number => Math.floor(Date.now() / 1000) + days * 86_400;

export interface EventBus {
  /** Best-effort eager relay. The outbox row is the source of truth; this is latency. */
  publish(events: readonly DomainEvent[]): Promise<void>;
  findSubjectLink(subject: string): Promise<{ residentId: string } | null>;
  clearSubjectLink(subject: string): Promise<void>;
}

export class DynamoDbEventBus implements EventBus {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    client = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async publish(events: readonly DomainEvent[]): Promise<void> {
    await Promise.all(
      events.map((e) =>
        this.doc.send(
          new PutCommand({
            TableName: this.table,
            Item: {
              pk: `evt#${randomUUID()}`,
              type: e.eventType,
              aggregateType: e.aggregateType,
              aggregateId: e.aggregateId,
              payload: e.payload,
              occurredAt: new Date().toISOString(),
              expiresAt: ttl(EVENT_TTL_DAYS),
            },
          }),
        ),
      ),
    );
  }

  async findSubjectLink(subject: string): Promise<{ residentId: string } | null> {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: `link#${subject}` } }),
    );
    const residentId = (out.Item as { residentId?: string } | undefined)?.residentId;
    return residentId ? { residentId } : null;
  }

  async clearSubjectLink(subject: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.table, Key: { pk: `link#${subject}` } }),
    );
  }
}

/** Used when no table is configured: local development and tests (NFR-14). */
export class NoopEventBus implements EventBus {
  readonly published: DomainEvent[] = [];
  async publish(events: readonly DomainEvent[]): Promise<void> {
    this.published.push(...events);
  }
  async findSubjectLink(): Promise<null> {
    return null;
  }
  async clearSubjectLink(): Promise<void> {
    /* nothing to do */
  }
}

export const LINK_TTL = LINK_TTL_DAYS;
