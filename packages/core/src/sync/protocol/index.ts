export {
  accountKey,
  decodeHead,
  decodeRevision,
  encode,
  entityKey,
  isPluginRequirement,
  providerReference,
  receiptSequence,
  revisionKey,
  SyncProtocolError,
  type DeletedAccount,
  type Dependency,
  type EntityBody,
  type EntityHead,
  type EntityKind,
  type JsonValue,
  type RevisionRecord,
} from './protocol';
export { EntityHeadSchema, parseHead, parseRevision, RevisionRecordSchema } from './schemas';
export { beginPurge, newHead, publish, reserve } from './transitions';
