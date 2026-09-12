import { z } from 'zod';

const JsonValueSchema: z.ZodType = z.json();

// `service-access` and `routing-defaults` have no authored key of their own, so their identity is
// fixed to their kind (see authoredEntityIdentities). Any other logical key would dodge the
// excluded canonical row, read as an unknown object, and still land `password`/`apiKeys` or the
// routing defaults on this device — so a noncanonical singleton is refused at the wire boundary.
const canonicalSingletonIdentity = (value: { readonly kind: string; readonly logicalKey: string }): boolean =>
  value.kind !== 'service-access' && value.kind !== 'routing-defaults' ? true : value.logicalKey === value.kind;

const singletonIdentityIssue = { message: 'singleton entity kinds must use their kind as the logical key' };

const DependencySchema = z.object({ objectId: z.string(), packageName: z.string(), version: z.string() });
const EntityBodySchema = z
  .object({
    kind: z.enum(['provider', 'model-rule', 'plugin-business', 'service-access', 'routing-defaults']),
    logicalKey: z.string(),
    value: JsonValueSchema,
    dependencies: z.array(DependencySchema),
  })
  .refine(canonicalSingletonIdentity, singletonIdentityIssue);

const EntityHeadFields = z.object({
  protocol: z.literal(1),
  objectId: z.string(),
  kind: z.enum(['provider', 'model-rule', 'plugin-business', 'service-access', 'routing-defaults']),
  logicalKey: z.string(),
  epoch: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  state: z.enum(['active', 'deleted', 'purging', 'purged']),
  current: z.string().nullable(),
  history: z.array(z.string()),
  reserved: z.array(z.string()),
  cancelling: z.array(z.string()),
  receipts: z.record(z.string(), z.number().int().positive()),
  cleanupComplete: z.boolean(),
});

export const EntityHeadSchema = EntityHeadFields.refine(canonicalSingletonIdentity, singletonIdentityIssue);

const PayloadRevisionSchema = z.object({
  protocol: z.literal(1),
  state: z.literal('payload'),
  objectId: z.string(),
  epoch: z.number().int().nonnegative(),
  operationId: z.string(),
  body: EntityBodySchema,
  publishedSequence: z.number().int().positive().nullable(),
  writtenAt: z.number().int().nonnegative().nullable(),
});

const ErasedRevisionSchema = z.object({
  protocol: z.literal(1),
  state: z.literal('erased'),
  objectId: z.string(),
  epoch: z.number().int().nonnegative(),
  operationId: z.string(),
  publishedSequence: z.number().int().positive().nullable(),
  reason: z.enum(['expired', 'purged', 'abandoned']),
});

export const RevisionRecordSchema = z.discriminatedUnion('state', [PayloadRevisionSchema, ErasedRevisionSchema]);

export function parseHead(value: unknown) {
  return EntityHeadSchema.parse(value);
}

export function parseRevision(value: unknown) {
  return RevisionRecordSchema.parse(value);
}
