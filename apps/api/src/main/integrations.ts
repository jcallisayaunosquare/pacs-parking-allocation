import { randomUUID } from 'node:crypto';
import { Logger } from '@aws-lambda-powertools/logger';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent, DynamoDBBatchResponse } from 'aws-lambda';
import { isUndeliverable } from './undeliverable-email';

/**
 * The only function outside the VPC (§10 Lambda inventory, ADR-016).
 *
 * In-VPC functions reach exactly two things — RDS and DynamoDB through a free gateway
 * endpoint. Anything needing the internet runs here instead, fed by the `pacs-events`
 * stream. That is what removes the NAT gateway, and it is why creating a resident does
 * not call Cognito inline.
 *
 * This function cannot reach the database either, so it does not try. It writes the
 * Cognito subject back as a `link#<sub>` item on the same table, and the API claims it
 * on the resident's first authenticated request.
 *
 * Idempotent by construction: an existing Cognito user is read rather than recreated,
 * so a stream retry or a replayed outbox row cannot produce duplicates.
 */
const logger = new Logger({ serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? 'pacs' });

const cognito = new CognitoIdentityProviderClient({});
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const EVENTS_TABLE = process.env.EVENTS_TABLE;
const LINK_TTL_DAYS = 30;

interface ResidentCreated {
  readonly residentId: string;
  readonly email: string;
  readonly fullName: string;
}

/** Creates the user if absent, returns the subject either way. */
async function provisionResident(p: ResidentCreated): Promise<string | null> {
  if (!USER_POOL_ID) throw new Error('COGNITO_USER_POOL_ID is not set.');

  const attributes = [
    { Name: 'email', Value: p.email },
    { Name: 'email_verified', Value: 'true' },
    { Name: 'name', Value: p.fullName },
    { Name: 'custom:resident_id', Value: p.residentId },
  ];

  let subject: string | undefined;
  try {
    const out = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: p.email,
        // Cognito emails the temporary password itself; no password passes through
        // this code, and the default sender needs no SES verification.
        DesiredDeliveryMediums: ['EMAIL'],
        // A reserved test address would only spend the daily email quota (50 on the
        // default sender) that real residents need; create the user without the email.
        ...(isUndeliverable(p.email) ? { MessageAction: 'SUPPRESS' as const } : {}),
        UserAttributes: attributes,
      }),
    );
    subject = out.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
    logger.info('cognito user created', { residentId: p.residentId });
  } catch (e) {
    if (!(e instanceof UsernameExistsException)) throw e;
    // Already there — a retry, or an administrator created it by hand. Read the sub.
    const existing = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: p.email }),
    );
    subject = existing.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
    logger.info('cognito user already existed', { residentId: p.residentId });
  }

  await cognito
    .send(
      new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: p.email,
        GroupName: 'RESIDENT',
      }),
    )
    .catch((e) => logger.warn('group assignment failed', { message: String(e) }));

  return subject ?? null;
}

async function writeSubjectLink(subject: string, residentId: string): Promise<void> {
  if (!EVENTS_TABLE) throw new Error('EVENTS_TABLE is not set.');
  await doc.send(
    new PutCommand({
      TableName: EVENTS_TABLE,
      Item: {
        pk: `link#${subject}`,
        type: 'SubjectLink',
        residentId,
        createdAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + LINK_TTL_DAYS * 86_400,
      },
    }),
  );
}

export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const id = record.dynamodb?.SequenceNumber ?? randomUUID();
    try {
      if (record.eventName === 'REMOVE' || !record.dynamodb?.NewImage) continue;

      const item = unmarshall(
        record.dynamodb.NewImage as Parameters<typeof unmarshall>[0],
      ) as { pk?: string; type?: string; payload?: unknown };

      // Our own link writes come back through the stream. Ignore them, or the
      // function feeds itself.
      if (item.type === 'SubjectLink' || !item.pk?.startsWith('evt#')) continue;

      switch (item.type) {
        case 'ResidentCreated': {
          const p = item.payload as ResidentCreated;
          if (!p?.residentId || !p?.email) {
            logger.warn('malformed ResidentCreated', { pk: item.pk });
            continue;
          }
          const subject = await provisionResident(p);
          if (subject) await writeSubjectLink(subject, p.residentId);
          break;
        }

        // M-5 notification templates land here next. Logged rather than dropped so
        // the delivery gap is visible instead of silent.
        case 'AllocationCompleted':
        case 'SpotAssigned':
        case 'ResidentWaitlisted':
        case 'AssignmentReleased':
        case 'WaitlistPromoted':
          logger.info('notification pending — SES templates not built yet', {
            type: item.type,
          });
          break;

        default:
          logger.info('unhandled event type', { type: item.type });
      }
    } catch (e) {
      logger.error('record failed', {
        sequenceNumber: id,
        message: e instanceof Error ? e.message : String(e),
      });
      // Report only the failed record, so one bad event cannot block the shard.
      failures.push({ itemIdentifier: id });
    }
  }

  return { batchItemFailures: failures };
};
