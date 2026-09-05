/**
 * Idempotency and the intent ledger.
 *
 * The Graph API has NO idempotency key — no header, no client request id, no dedupe
 * token. Error `506` ("duplicate post") is a content heuristic on Page posts, not a
 * guarantee. So any retried `POST /campaigns|/adsets|/ads|/adcreatives` can create a
 * second object that spends real money, and Meta codes 1 and 2 are classified
 * AMBIGUOUS in errors.ts precisely because the write may have landed *before* the
 * failure surfaced.
 *
 * Four layers, all of which are required — any one alone leaks:
 *
 *   1. A deterministic intent key derived from the intent, never from the attempt.
 *   2. An append-only intent ledger on disk (JSONL), written and fsynced BEFORE the
 *      network call, so the row survives the crash that loses the response.
 *   3. Reconciliation against Meta via AdLabels and the `*bylabels` edges: an ambiguous
 *      failure is resolved by SEARCHING for the object, never by blind retry.
 *   4. A guard that refuses to reserve an unresolved intent at all until (3) has run.
 *
 * The ordering contract that makes recovery sound, and which callers must not break:
 *
 *      reserve()  ->  ensureIntentLabel()  ->  POST the object with that label
 *
 * The label id is persisted before the object write is issued. Therefore an intent
 * record with no `labelId` proves the object write was never issued, and is safe to
 * re-attempt without a network round trip. Reverse the order and that proof is gone.
 *
 * ONE WRITER PER LEDGER FILE. Derived state lives in memory, so a second process
 * appending to the same file reasons from a stale view and will happily re-issue a
 * write the first process already made — there is no Temporal workflow-id dedupe here
 * to catch it (synthesis §14.1 layer 4 is not implemented in this codebase). The ledger
 * therefore polices it itself: every append first checks the file is exactly the size
 * this instance believes it left, and refuses otherwise. That check runs before the
 * RESERVE row and again before the LABEL row, both of which precede the object POST, so
 * the loser of the race is stopped before it can spend anything.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { MetaApiError } from './errors.ts';
import { SpendGuardError } from './client.ts';
import type { RuntimeMode } from './client.ts';

// ---------------------------------------------------------------------------
// Layer 1 — deterministic intent identity
// ---------------------------------------------------------------------------

/**
 * Version of the canonicaliser AND of the key recipe, mixed into every digest.
 *
 * Bump this whenever the canonicalisation rules below change. Without it, changing a
 * rule silently drives the hit rate to zero: every in-flight intent re-hashes to a new
 * key, every ledger lookup misses, and the recovery path happily re-creates objects
 * that already exist. A version bump invalidates cleanly instead of colliding — the old
 * keys are still in the ledger and still reconcilable, they simply no longer match.
 */
export const INTENT_KEY_VERSION = 'ik1' as const;

/** Non-integer numbers are rounded to this many decimal places before hashing. */
export const FLOAT_PRECISION = 6;

export type IntentKind = 'campaign' | 'adset' | 'ad' | 'adcreative' | 'advideo' | 'adimage';

export interface IntentIdentity {
  /** Brand slug. Stable by contract (domain/brand.ts validates it). */
  brandId: string;
  /** `act_<id>`. Meta object ids are per ad account, so the account is part of identity. */
  adAccountId: string;
  kind: IntentKind;
  /**
   * The logical role of this object inside the publish tree — what it *is for*, not
   * what it is called. Two ads in one tree differ by role, not by name, because an
   * autonomous system renames things.
   */
  role: string;
  /** The logical write parameters. Content-hashed; see canonicalJson for the rules. */
  params: Record<string, unknown>;
}

export interface PublishIntent extends IntentIdentity {
  /**
   * Part of the key, deliberately.
   *
   * SIMULATE confirms a fabricated object id (`simulated_…`). If SIMULATE and LIVE
   * shared a key, the first LIVE publish would find a CONFIRMED row, return the fake
   * id and never publish anything — a brand that silently never goes live. STAGE
   * creates real PAUSED objects, which are also not the LIVE ones.
   */
  mode: RuntimeMode;
}

/** Thrown when the params cannot be canonicalised into a stable key. */
export class IntentKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntentKeyError';
  }
}

/**
 * Keys whose value is a property of the *attempt*, not of the *intent*.
 *
 * Including any of these would make every retry hash differently, which is exactly the
 * bug this module exists to prevent — so they are rejected loudly rather than dropped
 * silently, because a caller who passes `created_at` believes it is significant and
 * needs to be told it is not. `access_token` and `appsecret_proof` are also refused
 * because the ledger is written to disk in plain text and must never carry a secret.
 *
 * Deliberately NOT in this list: `start_time`, `end_time`, `seed`. Those are
 * deterministic and load-bearing parts of an intent.
 */
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  'access_token', 'appsecret_proof', 'client_secret',
  'timestamp', 'ts', 'now', 'current_time', 'created_at', 'updated_at',
  'request_id', 'requestId', 'nonce', 'attempt', 'attempts', 'run_id',
  'trace_id', 'fbtrace_id', 'correlation_id', 'session_id', 'user_agent', 'uuid',
]);

/**
 * Deterministic serialisation. The rules, and why each one exists:
 *
 * - **Object keys sorted** — JS preserves insertion order, so two code paths building
 *   the same logical params in a different order would otherwise hash differently.
 * - **`null`/`undefined` values dropped from objects** — an omitted key and an explicit
 *   null are the same intent on the wire.
 * - **Empty arrays and objects PRESERVED** — `special_ad_categories: []` is required on
 *   every campaign create and means something entirely different from omitting it.
 * - **Array order preserved** — arrays are ordered on the wire (`adlabels`, asset
 *   sequences). Callers must build them deterministically; sorting them here would be
 *   wrong for asset order.
 * - **Non-integer numbers rounded** — `0.1 + 0.2` must not hash differently from `0.3`.
 * - **Strings that contain a JSON object or array are canonicalised as structure and
 *   re-quoted as a string** — every Meta param is a string on the wire and several
 *   (`targeting`, `object_story_spec`, `promoted_object`) are JSON blobs whose key
 *   order is an accident of construction. Re-quoting rather than inlining keeps the
 *   string form distinguishable from the structured form, so no collision is
 *   introduced.
 * - **Dates, bigints, functions and symbols rejected** — see IntentKeyError messages.
 */
export function canonicalJson(value: unknown): string {
  return canon(value, '$');
}

function canon(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      return canonNumber(value, path);

    case 'string':
      return canonString(value, path);

    case 'bigint':
      // Meta object ids exceed 2^53 and are carried as strings everywhere in this
      // codebase (see parseBigIntSafe in client.ts). A bigint here means someone
      // parsed an id numerically, which is the precision bug that writes against
      // somebody else's campaign.
      throw new IntentKeyError(
        `${path}: bigint is not permitted in an intent. Meta ids exceed 2^53 and are ` +
          `handled as strings throughout this codebase — pass "${value.toString()}".`,
      );

    case 'undefined':
      // Only reachable from inside an array; object properties are filtered earlier.
      throw new IntentKeyError(
        `${path}: undefined inside an array would shift every later element if dropped. ` +
          `Remove the hole, or use an explicit sentinel value.`,
      );

    case 'function':
    case 'symbol':
      throw new IntentKeyError(`${path}: ${typeof value} cannot be part of a content hash.`);

    default:
      break;
  }

  if (Array.isArray(value)) {
    const items = value.map((v, i) => {
      if (v === null || v === undefined) {
        throw new IntentKeyError(
          `${path}[${i}]: null/undefined inside an array. Dropping it would shift every ` +
            `later element and silently change the intent; keeping it is meaningless to Meta.`,
        );
      }
      return canon(v, `${path}[${i}]`);
    });
    return `[${items.join(',')}]`;
  }

  if (value instanceof Date) {
    throw new IntentKeyError(
      `${path}: a Date is a property of the attempt, not of the intent. If the time is ` +
        `genuinely part of what is being published (a schedule), pass an ISO string.`,
    );
  }

  // Only plain objects hash meaningfully. A Map, a Set, a RegExp or a class instance
  // with accessor-only state has NO own enumerable properties, so it canonicalises to
  // `{}` — every one of them identical to every other. That is a silent collision
  // between distinct intents, which is strictly worse than the Date case above, so it
  // is refused for the same reason and just as loudly.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name ?? 'object';
    throw new IntentKeyError(
      `${path}: a ${ctor} is not a plain object. Its state is not own enumerable ` +
        `properties, so it would hash as {} and collide with every other ${ctor} — ` +
        `convert it to the plain params Meta is actually sent.`,
    );
  }

  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    if (VOLATILE_KEYS.has(key)) {
      throw new IntentKeyError(
        `${path}.${key}: "${key}" varies between attempts, so including it would give ` +
          `every retry a different intent key and defeat duplicate detection entirely. ` +
          `Remove it from the intent params.`,
      );
    }
    const v = obj[key];
    if (v === null || v === undefined) continue; // absent and explicitly-null are one intent
    parts.push(`${JSON.stringify(key)}:${canon(v, `${path}.${key}`)}`);
  }
  return `{${parts.join(',')}}`;
}

function canonNumber(n: number, path: string): string {
  if (!Number.isFinite(n)) {
    throw new IntentKeyError(`${path}: ${String(n)} is not representable in JSON.`);
  }
  if (Number.isInteger(n)) {
    if (!Number.isSafeInteger(n)) {
      // Same precision bug as the bigint case, arriving by a quieter road. Meta ids are
      // ~17 digits, past 2^53, so `page_id: 120210000000000001` and
      // `…002` are the SAME double — two distinct intents collapsing onto one key, and
      // the second publish would return the first object's id as ALREADY_CONFIRMED.
      throw new IntentKeyError(
        `${path}: ${String(n)} is beyond 2^53 and is not the number that was written — ` +
          `doubles cannot distinguish adjacent Meta ids, so two different intents would ` +
          `hash to one key. Pass the id as a string.`,
      );
    }
    return String(n === 0 ? 0 : n); // normalises -0 to 0
  }
  const factor = 10 ** FLOAT_PRECISION;
  // No overflow guard: every double large enough to overflow the scaling (|n| >= 2^52)
  // is already an integer and returned or refused above, so this multiplication cannot
  // reach Infinity.
  const rounded = Math.round(n * factor) / factor;
  return String(rounded === 0 ? 0 : rounded);
}

function canonString(s: string, path: string): string {
  // A Meta param is always a string on the wire; the JSON-valued ones must not depend
  // on the key order the caller happened to build them with.
  const first = s.charCodeAt(0);
  if (first === 0x7b /* { */ || first === 0x5b /* [ */) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch {
      return JSON.stringify(s); // just a string that happens to start with a brace
    }
    if (typeof parsed === 'object' && parsed !== null) {
      return JSON.stringify(canon(parsed, `${path}(json)`));
    }
  }
  return JSON.stringify(s);
}

/**
 * The intent key: 128 bits of SHA-256 over the canonicalised identity.
 *
 * Derived from the intent (brand, account, kind, role, mode, content) and never from
 * the attempt, so the same logical write always produces the same value however many
 * times it is retried, in whatever process.
 */
export function intentKey(intent: PublishIntent): string {
  requireNonEmpty(intent.brandId, 'brandId');
  requireNonEmpty(intent.adAccountId, 'adAccountId');
  requireNonEmpty(intent.role, 'role');

  // Hashing a JSON *array* rather than a delimiter-joined string makes it impossible
  // for a value containing the delimiter to impersonate a different tuple.
  const material = canonicalJson([
    INTENT_KEY_VERSION,
    intent.brandId,
    intent.adAccountId,
    intent.kind,
    intent.role,
    intent.mode,
    intent.params,
  ]);
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32);
}

function requireNonEmpty(v: string, field: string): void {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new IntentKeyError(
      `${field} must be a non-empty string — an empty component silently collides ` +
        `distinct intents onto one key, which is a double-spend waiting to happen.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Name and label stamping
// ---------------------------------------------------------------------------

const NAME_STAMP = /\[idem:([0-9a-f]{32})\]/;
/** Every stamp, with the space that precedes it — used to strip before re-stamping. */
const NAME_STAMP_ALL = /\s*\[idem:[0-9a-f]{32}\]/g;

/**
 * Conservative cap on a stamped object name.
 *
 * UNVERIFIED: the research corpus records no documented maximum length for campaign,
 * ad set or ad names. 255 is a guess chosen to be safely under any plausible limit.
 * Only the human-readable prefix is ever truncated — the stamp is what recovery
 * depends on and is never sacrificed.
 */
export const NAME_MAX_LENGTH = 255;

/** The AdLabel name carrying an intent key. Matches the `idem:<key>` convention in §14.1. */
export function intentLabelName(key: string): string {
  return `idem:${key}`;
}

/**
 * Stamps the intent key into an object's `name` as a second, human-visible recovery
 * path. AdLabels are the primary mechanism (they are a first-class filterable edge and
 * `name` is not a documented filter on `GET /act_{id}/campaigns`), but a stamped name
 * is what lets an operator find the object in Ads Manager at 3am.
 */
export function stampIntentKey(baseName: string, key: string, maxLength = NAME_MAX_LENGTH): string {
  const stamp = ` [idem:${key}]`;
  const room = maxLength - stamp.length;
  if (room < 1) {
    throw new IntentKeyError(
      `maxLength ${maxLength} leaves no room for the ${stamp.length}-char intent stamp.`,
    );
  }
  // Any stamp the base name already carries is stripped first. An autonomous system
  // renames objects by editing the name it read back from Meta, so a base name arriving
  // here pre-stamped is expected — and leaving both stamps in place is worse than
  // useless: extractIntentKey returns the FIRST match, which is the stale one, so
  // reconcileByLabel would reject the object as belonging to another intent and strand
  // recovery on an object that is genuinely ours.
  const stripped = baseName.replace(NAME_STAMP_ALL, '');
  const base = stripped.length > room ? stripped.slice(0, room) : stripped;
  return `${base}${stamp}`;
}

export function extractIntentKey(name: string): string | undefined {
  return NAME_STAMP.exec(name)?.[1];
}

// ---------------------------------------------------------------------------
// Layer 2 — the append-only intent ledger
// ---------------------------------------------------------------------------

export type IntentState =
  /** Reserved. The write may have been issued; it may have landed. Not safe to retry. */
  | 'PENDING'
  /** The Meta object id is known. The write must never be issued again. */
  | 'CONFIRMED'
  /** Definitively did not create an object. Safe to re-attempt the same intent. */
  | 'FAILED'
  /** The attempt failed in a way that may still have created an object. Reconcile first. */
  | 'AMBIGUOUS'
  /** Reconciliation found more than one object. A double-create already happened. */
  | 'DUPLICATE';

export type ConfirmSource = 'WRITE' | 'RECONCILE' | 'DUPLICATE_RESOLUTION';

interface BaseEvent {
  /** Record schema version, so the ledger stays readable across releases. */
  v: 1;
  key: string;
  /** Epoch ms from the injected clock. Never Date.now(). */
  at: number;
}

export interface ReserveEvent extends BaseEvent {
  event: 'RESERVE';
  attempt: number;
  brandId: string;
  adAccountId: string;
  kind: IntentKind;
  role: string;
  mode: RuntimeMode;
  canonicaliser: string;
  labelName: string;
  params: Record<string, unknown>;
}
export interface LabelEvent extends BaseEvent {
  event: 'LABEL';
  labelId: string;
  labelName: string;
}
export interface ConfirmEvent extends BaseEvent {
  event: 'CONFIRM';
  metaObjectId: string;
  via: ConfirmSource;
  /** Present when a human resolved something; e.g. which duplicates were archived. */
  note?: string;
}
export interface FailEvent extends BaseEvent {
  event: 'FAIL';
  reason: string;
}
export interface AmbiguousEvent extends BaseEvent {
  event: 'AMBIGUOUS';
  reason: string;
}
export interface DuplicateEvent extends BaseEvent {
  event: 'DUPLICATE';
  objectIds: string[];
  reason: string;
}

export type LedgerEvent =
  | ReserveEvent
  | LabelEvent
  | ConfirmEvent
  | FailEvent
  | AmbiguousEvent
  | DuplicateEvent;

const EVENT_NAMES: ReadonlySet<string> = new Set([
  'RESERVE', 'LABEL', 'CONFIRM', 'FAIL', 'AMBIGUOUS', 'DUPLICATE',
]);

/** The state of one intent, derived by replaying its events. */
export interface IntentRecord {
  key: string;
  brandId: string;
  adAccountId: string;
  kind: IntentKind;
  role: string;
  mode: RuntimeMode;
  params: Record<string, unknown>;
  state: IntentState;
  attempts: number;
  labelName: string;
  labelId: string | undefined;
  metaObjectId: string | undefined;
  duplicateObjectIds: readonly string[] | undefined;
  reservedAt: number;
  updatedAt: number;
  lastReason: string | undefined;
}

export interface DoneReservation {
  status: 'ALREADY_CONFIRMED';
  key: string;
  metaObjectId: string;
  record: IntentRecord;
}

export interface ProceedReservation {
  status: 'PROCEED';
  key: string;
  attempt: number;
  /** Create this AdLabel and attach it to the object. See ensureIntentLabel. */
  labelName: string;
  /** Already-created label from an earlier attempt, if any. */
  labelId: string | undefined;
  record: IntentRecord;
  confirm(metaObjectId: string): IntentRecord;
  fail(reason: string): IntentRecord;
  markAmbiguous(reason: string): IntentRecord;
}

export type Reservation = DoneReservation | ProceedReservation;

/**
 * Thrown when an intent is reserved again while its previous attempt is unresolved.
 *
 * This is the guard: a PENDING row means the write may be in flight or may have landed
 * and lost its response; an AMBIGUOUS row means Meta returned code 1 or 2 over a write
 * that may already exist. Retrying either without reconciling is how you get two live
 * campaigns spending the same budget twice.
 */
export class UnreconciledWriteError extends Error {
  readonly key: string;
  readonly state: IntentState;
  constructor(record: IntentRecord) {
    super(
      `Refusing to re-issue intent ${record.key} (${record.kind} "${record.role}" for ` +
        `brand ${record.brandId}): its last attempt is ${record.state} after ` +
        `${record.attempts} attempt(s)${record.lastReason ? ` — ${record.lastReason}` : ''}. ` +
        `The Graph API has no idempotency key, so this write may already have created a ` +
        `money-spending object. Reconcile first: ` +
        `GET /${record.adAccountId}/${byLabelEdgeFor(record.kind) ?? '<no *bylabels edge for this kind>'}` +
        `?ad_label_ids=["${record.labelId ?? '<no label recorded — the write was never issued>'}"]` +
        `&operator=ALL — or call reconcileAndReserve().`,
    );
    this.name = 'UnreconciledWriteError';
    this.key = record.key;
    this.state = record.state;
  }
}

/** Thrown when more than one Meta object exists for a single intent. Page a human. */
export class DuplicateObjectError extends Error {
  readonly key: string;
  readonly objectIds: readonly string[];
  constructor(key: string, objectIds: readonly string[], detail: string) {
    super(
      `DOUBLE-CREATE on intent ${key}: ${objectIds.length} Meta objects carry this ` +
        `intent label (${objectIds.join(', ')}). ${detail} Keep the lowest id, archive the ` +
        `rest, and page a human — every extra object is spending real money.`,
    );
    this.name = 'DuplicateObjectError';
    this.key = key;
    this.objectIds = objectIds;
  }
}

/** Thrown when the ledger on disk cannot be trusted. A human must look. */
export class LedgerCorruptError extends Error {
  constructor(path: string, line: number, detail: string) {
    super(
      `Intent ledger ${path} is corrupt at line ${line}: ${detail}. This file is the only ` +
        `record of which writes may be in flight, so it is not safe to publish without it. ` +
        `Repair or quarantine it before running again.`,
    );
    this.name = 'LedgerCorruptError';
  }
}

/**
 * Thrown when a ledger event would move an intent backwards out of a settled state.
 *
 * The dangerous one is FAIL or AMBIGUOUS over a CONFIRMED intent: a caller whose
 * try-block spans both the write and the post-write verification will report the
 * verification failure against the same key, and a FAILED intent is retryable — so the
 * next run re-creates a campaign that already exists and is already spending. There is
 * no legitimate reason to unsettle a confirmed intent; the fix is a new intent.
 */
export class IntentTransitionError extends Error {
  readonly key: string;
  readonly from: IntentState;
  constructor(key: string, from: IntentState, event: LedgerEvent['event'], why: string) {
    super(`Refusing ${event} on intent ${key}: ${why}.`);
    this.name = 'IntentTransitionError';
    this.key = key;
    this.from = from;
  }
}

/**
 * Thrown when the ledger file has grown behind this instance's back.
 *
 * Two publishers on one ledger both read "nothing reserved", both reserve, and both
 * create — the exact double-spend the ledger exists to prevent, invisible afterwards
 * because the replay collapses the two RESERVE rows into one record. Refusing here
 * costs a stopped run; not refusing costs a duplicate live campaign.
 */
export class LedgerConcurrentWriteError extends Error {
  constructor(path: string, expectedBytes: number, actualBytes: number) {
    super(
      `Intent ledger ${path} changed underneath this process (expected ${expectedBytes} ` +
        `bytes, found ${actualBytes}). Another publisher is appending to the same ledger, ` +
        `so this process's view of what is already in flight is stale and it must not ` +
        `issue a write. Run one publisher per ledger file — the Graph API has no ` +
        `idempotency key, so two concurrent runs of the same intent create two ` +
        `money-spending objects.`,
    );
    this.name = 'LedgerConcurrentWriteError';
  }
}

/**
 * Which ledger events may follow which state.
 *
 * Enforced in the replay rather than only in the mutators, so that a hand-edited or
 * concurrently-written file is rejected at load instead of quietly rehydrating into a
 * record that says "safe to create" about an object that already exists.
 */
function transitionRefusal(record: IntentRecord, event: LedgerEvent): string | undefined {
  switch (event.event) {
    case 'RESERVE':
      if (record.state === 'CONFIRMED') {
        return (
          `it is already CONFIRMED as Meta object ${record.metaObjectId ?? '<unknown>'}; ` +
          `reserving again would re-issue a write that has already created a ` +
          `money-spending object`
        );
      }
      if (record.state === 'DUPLICATE') {
        return (
          `it is latched DUPLICATE (${record.duplicateObjectIds?.join(', ') ?? 'no ids recorded'}); ` +
          `reserving again would clear a double-create alarm no human has resolved`
        );
      }
      return undefined;

    case 'CONFIRM':
      if (record.state === 'CONFIRMED' && record.metaObjectId !== event.metaObjectId) {
        return (
          `it is already CONFIRMED as ${record.metaObjectId ?? '<unknown>'}, and one intent ` +
          `cannot own two objects — ${event.metaObjectId} is a double-create`
        );
      }
      if (record.state === 'DUPLICATE' && event.via !== 'DUPLICATE_RESOLUTION') {
        return (
          `it is latched DUPLICATE; deciding which of ${record.duplicateObjectIds?.length ?? 0} ` +
          `spending objects survives is a human's call — use resolveDuplicate()`
        );
      }
      return undefined;

    case 'FAIL':
    case 'AMBIGUOUS':
      if (record.state === 'CONFIRMED') {
        return (
          `it is CONFIRMED as Meta object ${record.metaObjectId ?? '<unknown>'}. A FAILED ` +
          `intent is retryable, so recording a failure here would make the next run create ` +
          `a second object. If something after the write failed, record that against the ` +
          `object, not against the intent that created it`
        );
      }
      if (record.state === 'DUPLICATE') {
        return `it is latched DUPLICATE and only resolveDuplicate() may clear that`;
      }
      return undefined;

    default:
      // LABEL and DUPLICATE are always admissible: the first only ever adds recovery
      // information, the second only ever raises an alarm.
      return undefined;
  }
}

export interface LedgerOptions {
  path: string;
  /**
   * Injected clock, epoch ms. Required rather than defaulted so no code path can
   * quietly reach for Date.now() and make a ledger irreproducible in a test.
   */
  now: () => number;
}

/**
 * A copy of the params that matches, byte for byte, what the JSONL row holds.
 *
 * A spread would share every nested object with the caller, and the whole value of an
 * append-only ledger is that what it says was reserved cannot be edited afterwards.
 * Round-tripping through JSON also drops the `undefined` values that JSON.stringify
 * omits from the row, so memory and disk agree.
 */
function cloneParams(params: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
}

/**
 * Append-only intent ledger, persisted as JSONL.
 *
 * There is no database in this system, so durability is bought with the plainest thing
 * that works: one JSON object per line, opened with O_APPEND, written and **fsynced**
 * before the call returns. The whole point of the ledger is to survive the crash that
 * loses the HTTP response, and an un-fsynced write in the page cache does not.
 *
 * Current state is derived by replaying the events, never stored — an append-only log
 * is the only shape that can answer "what did we believe when we issued that write",
 * which is the question an unattended spender has to be auditable on.
 */
export class IntentLedger {
  readonly path: string;
  /** Non-fatal problems found while loading, e.g. a torn final line. Surface these. */
  readonly warnings: readonly string[];

  private readonly nowFn: () => number;
  private readonly byKey = new Map<string, IntentRecord>();
  /** Bytes of `path` this instance has accounted for. See assertSoleWriter. */
  private bytesOnDisk = 0;
  /**
   * Set when the file's last record is complete but its terminating newline is not.
   * The next append then leads with one, so the two records cannot be welded together.
   * See load().
   */
  private pendingNewline = false;

  constructor(opts: LedgerOptions) {
    this.path = opts.path;
    this.nowFn = opts.now;
    const warnings: string[] = [];
    this.load(warnings);
    this.warnings = warnings;
  }

  private load(warnings: string[]): void {
    if (!existsSync(this.path)) return;
    const buf = readFileSync(this.path);
    // Bytes, not lines: every append re-checks this against the file on disk, which is
    // how a second process writing the same ledger gets caught.
    this.bytesOnDisk = buf.length;
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.trim() === '') continue;
      const isFinal = i === lines.length - 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        // A crash mid-append can tear only the LAST line. Anything earlier means the
        // file has been edited or the disk lied, and neither is safe to guess past.
        if (isFinal) {
          this.truncateTornTail(buf.length - Buffer.byteLength(line, 'utf8'), err);
          warnings.push(
            `dropped torn final line ${i + 1} of ${this.path} (${String(err)}). It was ` +
              `being written when the process died, so the intent it described is at ` +
              `worst PENDING and will be reconciled before any retry. The incomplete ` +
              `bytes have been truncated so the next append starts on a clean record.`,
          );
          continue;
        }
        throw new LedgerCorruptError(this.path, i + 1, `unparseable JSON (${String(err)})`);
      }
      const event = parseLedgerEvent(parsed);
      if (typeof event === 'string') throw new LedgerCorruptError(this.path, i + 1, event);
      this.apply(event, i + 1);
    }

    // A crash inside writeSync can stop anywhere in the line — including one byte short
    // of the end, leaving a record that is complete and parseable but unterminated. That
    // one lands here rather than in the torn-tail branch above, and appending straight
    // after it would weld two records into a single unparseable line that is no longer
    // final, which the loop refuses forever: the ledger would be permanently unreadable
    // and publishing cannot proceed without it. Truncating is not the answer either —
    // the record is real and may be the CONFIRM that proves an object exists. So keep it
    // and make the next append supply the missing separator.
    if (this.bytesOnDisk > 0 && buf[this.bytesOnDisk - 1] !== 0x0a) {
      this.pendingNewline = true;
      warnings.push(
        `the last record of ${this.path} is complete but its terminating newline is ` +
          `missing, so the process died mid-append. The record has been kept and the ` +
          `next append will start with a newline; nothing was discarded.`,
      );
    }
  }

  /**
   * Cuts an incomplete trailing record off the file.
   *
   * Without this the tolerance above is a trap: the next append lands immediately after
   * the fragment, welding it onto a valid record to make one unparseable line that is
   * no longer final — so every later run refuses to load the ledger at all, and the
   * ledger is the one thing publishing cannot proceed without. Only bytes that were
   * never a complete fsynced record are removed, which is exactly what the crash left.
   */
  private truncateTornTail(keepBytes: number, cause: unknown): void {
    try {
      truncateSync(this.path, keepBytes);
    } catch (err) {
      throw new LedgerCorruptError(
        this.path,
        -1,
        `the final record is incomplete (${String(cause)}) and the torn bytes after ` +
          `offset ${keepBytes} could not be truncated (${String(err)}). Appending after ` +
          `them would fuse the fragment onto the next record and make this ledger ` +
          `permanently unreadable, so publishing must not continue until a human ` +
          `removes the incomplete final line`,
      );
    }
    this.bytesOnDisk = keepBytes;
    this.pendingNewline = false; // keepBytes lands on a record boundary, i.e. after a \n
  }

  /**
   * Replays one event onto the derived state. Used by both load and append.
   *
   * `line` is set only when replaying a file, so the same illegal transition is
   * reported as a corrupt ledger when it is read and as a programming error when a
   * caller attempts it live.
   */
  private apply(event: LedgerEvent, line?: number): void {
    const existing = this.byKey.get(event.key);
    if (existing) {
      const refusal = transitionRefusal(existing, event);
      if (refusal !== undefined) {
        if (line !== undefined) throw new LedgerCorruptError(this.path, line, refusal);
        throw new IntentTransitionError(event.key, existing.state, event.event, refusal);
      }
    }

    if (event.event === 'RESERVE') {
      const record: IntentRecord = {
        key: event.key,
        brandId: event.brandId,
        adAccountId: event.adAccountId,
        kind: event.kind,
        role: event.role,
        mode: event.mode,
        params: cloneParams(event.params),
        state: 'PENDING',
        attempts: event.attempt,
        labelName: event.labelName,
        labelId: existing?.labelId,
        metaObjectId: undefined,
        duplicateObjectIds: undefined,
        reservedAt: existing?.reservedAt ?? event.at,
        updatedAt: event.at,
        lastReason: undefined,
      };
      this.byKey.set(event.key, record);
      return;
    }

    if (!existing) {
      // An event for an unknown key means the RESERVE line is missing — the ledger no
      // longer describes a coherent history, and its whole job is to be trustworthy.
      throw new LedgerCorruptError(
        this.path,
        line ?? -1,
        `${event.event} for unreserved key ${event.key}`,
      );
    }
    const record = existing;
    record.updatedAt = event.at;

    switch (event.event) {
      case 'LABEL':
        record.labelId = event.labelId;
        record.labelName = event.labelName;
        break;
      case 'CONFIRM':
        record.state = 'CONFIRMED';
        record.metaObjectId = event.metaObjectId;
        if (event.note !== undefined) record.lastReason = event.note;
        break;
      case 'FAIL':
        record.state = 'FAILED';
        record.lastReason = event.reason;
        break;
      case 'AMBIGUOUS':
        record.state = 'AMBIGUOUS';
        record.lastReason = event.reason;
        break;
      case 'DUPLICATE':
        record.state = 'DUPLICATE';
        record.duplicateObjectIds = event.objectIds;
        record.lastReason = event.reason;
        break;
    }
  }

  private append(event: LedgerEvent): void {
    // Before anything: is this still the only writer? A stale in-memory view is how the
    // same intent gets issued twice, and every append here precedes a network call.
    this.assertSoleWriter();
    // State next, so an apply() that rejects the event never leaves a line on disk that
    // the next load would also reject.
    this.apply(event);
    const line = `${this.pendingNewline ? '\n' : ''}${JSON.stringify(event)}\n`;
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, 'a');
    try {
      writeSync(fd, line);
      fsyncSync(fd); // the row must be durable BEFORE the network call, or it is useless
    } finally {
      closeSync(fd);
    }
    this.bytesOnDisk += Buffer.byteLength(line, 'utf8');
    this.pendingNewline = false;
  }

  /**
   * Refuses to append unless the file is exactly the size this instance left it.
   *
   * O_APPEND makes concurrent writes non-destructive, so the file would stay readable —
   * and that is the danger: two publishers would each create an object and the replay
   * would show one intent, one record, no sign of the duplicate. A size mismatch is a
   * cheap, allocation-free way to notice, and it fires at RESERVE and again at LABEL,
   * both of which happen before the object POST.
   */
  private assertSoleWriter(): void {
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
    }
    if (size !== this.bytesOnDisk) {
      throw new LedgerConcurrentWriteError(this.path, this.bytesOnDisk, size);
    }
  }

  /**
   * A record nobody outside can mutate.
   *
   * `params` in particular: the RESERVE row on disk is immutable, so an in-memory record
   * that aliases the caller's params object lets a later mutation rewrite the audit
   * trail — `all()` would then disagree with the file that is the actual evidence of
   * what was published.
   */
  private copy(r: IntentRecord): IntentRecord {
    return {
      ...r,
      params: cloneParams(r.params),
      duplicateObjectIds: r.duplicateObjectIds === undefined ? undefined : [...r.duplicateObjectIds],
    };
  }

  get(key: string): IntentRecord | undefined {
    const r = this.byKey.get(key);
    return r ? this.copy(r) : undefined;
  }

  all(): IntentRecord[] {
    return [...this.byKey.values()].map((r) => this.copy(r));
  }

  /** Intents that cannot be retried until a human or reconciliation resolves them. */
  unresolved(): IntentRecord[] {
    return this.all().filter(
      (r) => r.state === 'PENDING' || r.state === 'AMBIGUOUS' || r.state === 'DUPLICATE',
    );
  }

  /**
   * Claims the right to issue this write, or refuses.
   *
   * Refuses (throws UnreconciledWriteError) whenever the previous attempt is
   * unresolved — that is layer 4. Returns ALREADY_CONFIRMED, without touching the
   * ledger, when the object already exists.
   */
  reserve(intent: PublishIntent): Reservation {
    const key = intentKey(intent);
    const existing = this.byKey.get(key);

    if (existing) {
      if (existing.state === 'CONFIRMED') {
        const metaObjectId = existing.metaObjectId;
        if (metaObjectId === undefined) {
          throw new LedgerCorruptError(this.path, -1, `CONFIRMED intent ${key} has no object id`);
        }
        return { status: 'ALREADY_CONFIRMED', key, metaObjectId, record: this.copy(existing) };
      }
      if (existing.state === 'DUPLICATE') {
        throw new DuplicateObjectError(
          key,
          existing.duplicateObjectIds ?? [],
          'Recorded by an earlier reconciliation and never resolved.',
        );
      }
      if (existing.state !== 'FAILED') throw new UnreconciledWriteError(existing);
    }

    const at = this.nowFn();
    const attempt = (existing?.attempts ?? 0) + 1;
    this.append({
      v: 1,
      event: 'RESERVE',
      key,
      at,
      attempt,
      brandId: intent.brandId,
      adAccountId: intent.adAccountId,
      kind: intent.kind,
      role: intent.role,
      mode: intent.mode,
      canonicaliser: INTENT_KEY_VERSION,
      labelName: intentLabelName(key),
      params: intent.params,
    });

    const record = this.byKey.get(key) as IntentRecord;
    return {
      status: 'PROCEED',
      key,
      attempt,
      labelName: record.labelName,
      labelId: record.labelId,
      record: this.copy(record),
      confirm: (metaObjectId: string) => this.confirm(key, metaObjectId),
      fail: (reason: string) => this.fail(key, reason),
      markAmbiguous: (reason: string) => this.markAmbiguous(key, reason),
    };
  }

  /** Records the AdLabel id. MUST be durable before the object write is issued. */
  recordLabel(key: string, labelId: string): IntentRecord {
    const record = this.require(key, 'recordLabel');
    if (typeof labelId !== 'string' || labelId === '') {
      throw new IntentKeyError(`recordLabel(${key}): labelId must be a non-empty string.`);
    }
    if (record.labelId !== undefined && record.labelId !== labelId) {
      // Harmless in itself — duplicate labels with the same name are fine — but the
      // stored id is what reconciliation queries by, so silently swapping it would
      // point recovery at a label no object carries.
      throw new IntentKeyError(
        `recordLabel(${key}): label id already recorded as ${record.labelId}; refusing to ` +
          `replace it with ${labelId}. Reconciliation queries by the stored id, and an ` +
          `object created under the old label would become invisible to it.`,
      );
    }
    this.append({ v: 1, event: 'LABEL', key, at: this.nowFn(), labelId, labelName: record.labelName });
    return this.snapshot(key);
  }

  /**
   * `note` is for how the id was learned when that is not obvious — chiefly the
   * `effective_status` of an object adopted by reconciliation, since a label pointing at
   * an ARCHIVED or DELETED object still means "do not create a second one" and whoever
   * reads this ledger later needs to know which it was.
   */
  confirm(
    key: string,
    metaObjectId: string,
    via: ConfirmSource = 'WRITE',
    note?: string,
  ): IntentRecord {
    const record = this.require(key, 'confirm');
    if (typeof metaObjectId !== 'string' || metaObjectId === '') {
      throw new IntentKeyError(
        `confirm(${key}): metaObjectId must be a non-empty string. Meta ids exceed 2^53 ` +
          `and must never be carried as JS numbers.`,
      );
    }
    if (record.state === 'CONFIRMED' && record.metaObjectId !== metaObjectId) {
      throw new DuplicateObjectError(
        key,
        [record.metaObjectId ?? '<unknown>', metaObjectId],
        'One intent has been confirmed against two different Meta object ids.',
      );
    }
    this.append({
      v: 1,
      event: 'CONFIRM',
      key,
      at: this.nowFn(),
      metaObjectId,
      via,
      ...(note !== undefined ? { note } : {}),
    });
    return this.snapshot(key);
  }

  /** The write definitively did not create an object. The intent may be re-attempted. */
  fail(key: string, reason: string): IntentRecord {
    this.require(key, 'fail');
    this.append({ v: 1, event: 'FAIL', key, at: this.nowFn(), reason });
    return this.snapshot(key);
  }

  /** The write may or may not have landed. Blocks every retry until reconciliation. */
  markAmbiguous(key: string, reason: string): IntentRecord {
    this.require(key, 'markAmbiguous');
    this.append({ v: 1, event: 'AMBIGUOUS', key, at: this.nowFn(), reason });
    return this.snapshot(key);
  }

  recordDuplicate(key: string, objectIds: readonly string[], reason: string): IntentRecord {
    this.require(key, 'recordDuplicate');
    this.append({
      v: 1,
      event: 'DUPLICATE',
      key,
      at: this.nowFn(),
      objectIds: [...objectIds],
      reason,
    });
    return this.snapshot(key);
  }

  /**
   * Closes out a double-create after a human has archived the extras.
   *
   * Deliberately not automatic: deciding which of two live campaigns keeps spending is
   * not a decision an unattended loop should make.
   */
  resolveDuplicate(key: string, keptObjectId: string, note: string): IntentRecord {
    const record = this.require(key, 'resolveDuplicate');
    if (record.state !== 'DUPLICATE') {
      throw new IntentKeyError(`resolveDuplicate(${key}): intent is ${record.state}, not DUPLICATE.`);
    }
    if (!record.duplicateObjectIds?.includes(keptObjectId)) {
      throw new IntentKeyError(
        `resolveDuplicate(${key}): ${keptObjectId} is not one of the duplicated objects ` +
          `(${record.duplicateObjectIds?.join(', ') ?? 'none recorded'}).`,
      );
    }
    // One event, not a FAIL followed by a CONFIRM: the duplicate ids stay on the record
    // for audit, and the note says what the human actually did about them.
    this.append({
      v: 1,
      event: 'CONFIRM',
      key,
      at: this.nowFn(),
      metaObjectId: keptObjectId,
      via: 'DUPLICATE_RESOLUTION',
      note,
    });
    return this.snapshot(key);
  }

  private require(key: string, op: string): IntentRecord {
    const record = this.byKey.get(key);
    if (!record) {
      throw new IntentKeyError(
        `${op}(${key}): no such intent in ${this.path}. Every write must be reserve()d ` +
          `first — that reservation is what makes an ambiguous failure recoverable.`,
      );
    }
    return record;
  }

  private snapshot(key: string): IntentRecord {
    return this.copy(this.require(key, 'snapshot'));
  }
}

const INTENT_KINDS: ReadonlySet<string> = new Set([
  'campaign', 'adset', 'ad', 'adcreative', 'advideo', 'adimage',
]);
// Duplicated from client.ts on purpose: RuntimeMode is a type, and a type cannot
// validate a line of JSON that came off a disk this process did not write.
const RUNTIME_MODES: ReadonlySet<string> = new Set(['SIMULATE', 'VALIDATE', 'STAGE', 'LIVE']);
const CONFIRM_SOURCES: ReadonlySet<string> = new Set(['WRITE', 'RECONCILE', 'DUPLICATE_RESOLUTION']);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v !== '';
}

/**
 * Parses one ledger line, or returns the reason it is not a usable event.
 *
 * The payload is checked field by field, not just the envelope. A row that parses as
 * JSON but is missing `adAccountId` would otherwise rehydrate into a record whose
 * reconciliation query is `GET undefined/campaignsbylabels` — a lookup that finds
 * nothing and therefore reports "safe to create" about an object that may exist.
 */
function parseLedgerEvent(v: unknown): LedgerEvent | string {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'not a JSON object';
  const o = v as Record<string, unknown>;
  if (o['v'] !== 1) return `unsupported record version ${JSON.stringify(o['v'])}`;
  if (!isNonEmptyString(o['key'])) return 'no intent key';
  if (typeof o['at'] !== 'number' || !Number.isFinite(o['at'])) return 'no usable timestamp';
  const name = o['event'];
  if (typeof name !== 'string' || !EVENT_NAMES.has(name)) {
    return `unrecognised event ${JSON.stringify(name)}`;
  }

  switch (name) {
    case 'RESERVE': {
      if (!isNonEmptyString(o['brandId'])) return 'RESERVE with no brandId';
      if (!isNonEmptyString(o['adAccountId'])) return 'RESERVE with no adAccountId';
      if (!isNonEmptyString(o['role'])) return 'RESERVE with no role';
      if (!isNonEmptyString(o['kind']) || !INTENT_KINDS.has(o['kind'])) {
        return `RESERVE with unknown kind ${JSON.stringify(o['kind'])}`;
      }
      if (!isNonEmptyString(o['mode']) || !RUNTIME_MODES.has(o['mode'])) {
        return `RESERVE with unknown runtime mode ${JSON.stringify(o['mode'])}`;
      }
      if (!isNonEmptyString(o['labelName'])) return 'RESERVE with no labelName';
      const attempt = o['attempt'];
      if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
        return `RESERVE with a non-positive attempt number ${JSON.stringify(attempt)}`;
      }
      const params = o['params'];
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        return 'RESERVE with no params object';
      }
      break;
    }
    case 'LABEL':
      if (!isNonEmptyString(o['labelId'])) return 'LABEL with no label id';
      if (!isNonEmptyString(o['labelName'])) return 'LABEL with no label name';
      break;
    case 'CONFIRM':
      if (!isNonEmptyString(o['metaObjectId'])) return 'CONFIRM with no Meta object id';
      if (!isNonEmptyString(o['via']) || !CONFIRM_SOURCES.has(o['via'])) {
        return `CONFIRM with unknown source ${JSON.stringify(o['via'])}`;
      }
      break;
    case 'FAIL':
    case 'AMBIGUOUS':
      if (typeof o['reason'] !== 'string') return `${name} with no reason`;
      break;
    case 'DUPLICATE': {
      const ids = o['objectIds'];
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isNonEmptyString)) {
        return 'DUPLICATE with no object ids';
      }
      if (typeof o['reason'] !== 'string') return 'DUPLICATE with no reason';
      break;
    }
  }
  return v as LedgerEvent;
}

// ---------------------------------------------------------------------------
// Layer 3 — reconciliation against Meta via AdLabels
// ---------------------------------------------------------------------------

/**
 * The `*bylabels` edges, verified in the v26.0.1 SDK codegen
 * (`facebook_business/adobjects/adaccount.py`), each taking
 * `{ad_label_ids: list<string>, operator: ALL|ANY}`.
 *
 * There are exactly three. There is NO `adcreativesbylabels`, `advideosbylabels` or
 * `adimagesbylabels` edge — which is survivable, because none of those objects spends
 * money on its own. A duplicate creative costs $0 and is garbage-collectable; the
 * reconcilable ad that references it is where the spend risk actually lives.
 */
export const BY_LABEL_EDGES = {
  campaign: 'campaignsbylabels',
  adset: 'adsetsbylabels',
  ad: 'adsbylabels',
} as const;

export type ByLabelEdge = (typeof BY_LABEL_EDGES)[keyof typeof BY_LABEL_EDGES];

export function byLabelEdgeFor(kind: IntentKind): ByLabelEdge | undefined {
  switch (kind) {
    case 'campaign':
      return BY_LABEL_EDGES.campaign;
    case 'adset':
      return BY_LABEL_EDGES.adset;
    case 'ad':
      return BY_LABEL_EDGES.ad;
    default:
      return undefined;
  }
}

/** Thrown when a runtime mode cannot support the operation being asked for. */
export class IntentModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntentModeError';
  }
}

/** Thrown for object kinds Meta gives no label-search edge for. */
export class ReconcileUnsupportedError extends Error {
  constructor(kind: IntentKind) {
    super(
      `No *bylabels edge exists for ${kind}: Meta provides only campaignsbylabels, ` +
        `adsetsbylabels and adsbylabels, so a ${kind} cannot be found by intent label. ` +
        `A duplicate ${kind} does not spend money on its own — create a fresh one and let ` +
        `the ad that references it carry the idempotency guarantee.`,
    );
    this.name = 'ReconcileUnsupportedError';
  }
}

/** Thrown when the object found under our label is demonstrably not ours. */
export class ReconcileMismatchError extends Error {
  constructor(key: string, objectId: string, foundKey: string) {
    super(
      `Reconciling intent ${key} found object ${objectId}, but its name carries intent ` +
        `key ${foundKey}. Confirming would bind this intent to somebody else's object. ` +
        `The stored label id is wrong or the label was reused — page a human.`,
    );
    this.name = 'ReconcileMismatchError';
  }
}

/** The subset of MetaClient this module needs. Structural, so a fake is trivial in tests. */
export interface GraphReader {
  get<T>(path: string, params?: Record<string, string>, ctx?: { adAccountId?: string }): Promise<T>;
}
export interface GraphWriter {
  /**
   * The client's runtime mode when it exposes one — MetaClient does. Optional so a test
   * fake need not carry it, but read when present: see ensureIntentLabel.
   */
  mode?: RuntimeMode;
  post<T>(
    path: string,
    params: Record<string, string>,
    ctx?: { adAccountId?: string; idempotencyKey?: string },
  ): Promise<T>;
}
export type GraphClient = GraphReader & GraphWriter;

export interface LabelledObject {
  id: string;
  name?: string;
  effective_status?: string;
}

export type ReconcileOutcome =
  | { status: 'ABSENT'; note: string }
  | { status: 'FOUND'; metaObjectId: string; object: LabelledObject }
  | { status: 'DUPLICATE'; objectIds: string[]; objects: LabelledObject[] };

export interface ReconcileRequest {
  adAccountId: string;
  kind: IntentKind;
  labelId: string;
  /** Expected intent key, cross-checked against the object's name stamp when present. */
  intentKey?: string;
}

/**
 * Asks Meta what actually exists under this intent's label.
 *
 * `effective_status` is requested explicitly because ARCHIVED and DELETED objects
 * vanish from default list queries while still existing, and "reconciling without
 * status filters, then re-creating what you think is missing" is a documented way to
 * double-create.
 *
 * UNVERIFIED: whether the `*bylabels` edges themselves return ARCHIVED/DELETED objects.
 * The SDK codegen lists only `ad_label_ids` and `operator` as parameters, so there is
 * no documented way to widen the query. An ABSENT result therefore means "no object is
 * visible on this edge", and that caveat is written into the ledger reason rather than
 * being quietly rounded off to "no object exists".
 */
export async function reconcileByLabel(
  graph: GraphReader,
  req: ReconcileRequest,
): Promise<ReconcileOutcome> {
  const edge = byLabelEdgeFor(req.kind);
  if (!edge) throw new ReconcileUnsupportedError(req.kind);

  const res = await graph.get<{ data?: unknown }>(
    `${req.adAccountId}/${edge}`,
    {
      ad_label_ids: JSON.stringify([req.labelId]),
      operator: 'ALL',
      fields: 'id,name,effective_status',
      limit: '50',
    },
    { adAccountId: req.adAccountId },
  );

  const objects = normaliseObjects(res?.data, edge);

  if (req.intentKey !== undefined) {
    for (const obj of objects) {
      const stamped = obj.name === undefined ? undefined : extractIntentKey(obj.name);
      // A missing stamp is fine — an autonomous system renames objects, and surviving
      // renames is exactly why labels are the primary mechanism. A DIFFERENT stamp is
      // not fine: it means this object belongs to another intent.
      if (stamped !== undefined && stamped !== req.intentKey) {
        throw new ReconcileMismatchError(req.intentKey, obj.id, stamped);
      }
    }
  }

  if (objects.length === 0) {
    return {
      status: 'ABSENT',
      note:
        `no object visible on ${edge} for label ${req.labelId}; whether this edge returns ` +
        `ARCHIVED/DELETED objects is UNVERIFIED`,
    };
  }
  const first = objects[0];
  if (objects.length === 1 && first) {
    return { status: 'FOUND', metaObjectId: first.id, object: first };
  }
  return { status: 'DUPLICATE', objectIds: objects.map((o) => o.id), objects };
}

function normaliseObjects(data: unknown, edge: string): LabelledObject[] {
  if (!Array.isArray(data)) {
    throw new Error(
      `Unexpected ${edge} response: expected a "data" array, got ${JSON.stringify(data)?.slice(0, 200)}. ` +
        `Reconciliation cannot guess, and guessing here creates duplicate spend.`,
    );
  }
  return data.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`Unexpected ${edge} response: data[${i}] is not an object.`);
    }
    const o = raw as Record<string, unknown>;
    const id = o['id'];
    if (typeof id !== 'string' || id === '') {
      // parseBigIntSafe in client.ts quotes wide integers; a numeric id here means it
      // came through a path that mangles precision, and a mangled id is another
      // advertiser's object.
      throw new Error(
        `Unexpected ${edge} response: data[${i}].id is ${JSON.stringify(id)}, expected a ` +
          `non-empty string (Meta ids exceed 2^53 and must not be parsed as numbers).`,
      );
    }
    return {
      id,
      ...(typeof o['name'] === 'string' ? { name: o['name'] } : {}),
      ...(typeof o['effective_status'] === 'string'
        ? { effective_status: o['effective_status'] }
        : {}),
    };
  });
}

/**
 * Creates the intent's AdLabel and persists its id before returning.
 *
 * The persist-before-return is the load-bearing part. If the label POST lands but its
 * response is lost, we simply create a second label on the next attempt — duplicate
 * labels with the same name are harmless because reconciliation queries by the stored
 * *id*, never by name. What must never happen is attaching a label whose id was never
 * written down, because the created object would then be invisible to recovery.
 */
export async function ensureIntentLabel(
  graph: GraphWriter,
  ledger: IntentLedger,
  key: string,
): Promise<string> {
  const record = ledger.get(key);
  if (!record) {
    throw new IntentKeyError(`ensureIntentLabel(${key}): reserve() the intent first.`);
  }
  if (record.labelId !== undefined) return record.labelId;
  if (graph.mode === 'VALIDATE') {
    // §10.3: VALIDATE sends execution_options=['validate_only'], so this POST creates
    // nothing and returns no id. Failing here with the generic "no usable id" message
    // would send whoever reads it hunting for a Meta bug that does not exist.
    throw new IntentModeError(
      `ensureIntentLabel(${key}): VALIDATE mode never creates Meta objects, so ` +
        `POST ${record.adAccountId}/adlabels cannot return a label id and this intent ` +
        `could never be made recoverable. Validate with execution_options=` +
        `['validate_only'] on the object create itself (synthesis §14.0); do not route a ` +
        `validation run through the intent ledger.`,
    );
  }

  const res = await graph.post<{ id?: unknown }>(
    `${record.adAccountId}/adlabels`,
    { name: record.labelName },
    { adAccountId: record.adAccountId, idempotencyKey: key },
  );
  const id = res?.id;
  if (typeof id !== 'string' || id === '') {
    throw new Error(
      `POST ${record.adAccountId}/adlabels returned no usable id (${JSON.stringify(res)?.slice(0, 200)}). ` +
        `Without a label id this write cannot be made recoverable, so it must not be issued.`,
    );
  }
  ledger.recordLabel(key, id);
  return id;
}

/**
 * The full recovery algorithm: reconcile anything unresolved, then reserve.
 *
 * This is the entry point the publish module should use for campaign/adset/ad writes.
 * It implements §14.1 of the synthesis:
 *
 *   1. CONFIRMED            -> return the object id, issue nothing.
 *   2. PENDING / AMBIGUOUS  -> query <kind>bylabels:
 *        exactly 1 -> confirm and return it
 *        more than 1 -> alarm; a double-create already happened
 *        0 -> safe to (re)issue
 *   3. otherwise            -> reserve and proceed.
 *
 * Three cases in step 2 are settled without asking Meta anything:
 *
 * - **No label id recorded.** Sound only because of the ordering contract at the top of
 *   this file: no object is created before its label id is durable, so an intent with
 *   no label cannot have created anything.
 * - **SIMULATE or VALIDATE.** Neither mode can have created an object — SIMULATE returns
 *   a fabricated id without opening a socket and VALIDATE sends `validate_only`
 *   (synthesis §10.3) — so there is nothing on Meta to find, and querying would spend a
 *   real read against the account during a dry run.
 * - **A kind with no `*bylabels` edge.** Creatives, videos and images cannot be found by
 *   label at all. Blocking them forever would strand an entire publish tree on an object
 *   that cannot spend money by itself, so the dossier's guidance is taken: accept the
 *   possible orphan and re-issue. The ad that references it is separately keyed and is
 *   where the spend guarantee actually lives.
 */
export async function reconcileAndReserve(
  ledger: IntentLedger,
  graph: GraphReader,
  intent: PublishIntent,
): Promise<Reservation> {
  const key = intentKey(intent);
  const existing = ledger.get(key);

  if (existing && (existing.state === 'PENDING' || existing.state === 'AMBIGUOUS')) {
    if (existing.labelId === undefined) {
      ledger.fail(
        key,
        `reconciled without a network call: no ad label was ever recorded, so the ` +
          `${existing.kind} write was never issued (attempt ${existing.attempts})`,
      );
    } else if (existing.mode === 'SIMULATE' || existing.mode === 'VALIDATE') {
      ledger.fail(
        key,
        `reconciled without a network call: ${existing.mode} mode never creates Meta ` +
          `objects, so no ${existing.kind} can exist to reconcile against (attempt ` +
          `${existing.attempts})`,
      );
    } else if (byLabelEdgeFor(existing.kind) === undefined) {
      // Deliberately not a throw: an unresolvable creative would otherwise latch the
      // whole tree PENDING forever and need a human at 3am to hand-edit an append-only
      // ledger. The residual risk is an orphan that costs $0 and is garbage-collectable.
      ledger.fail(
        key,
        `cannot reconcile a ${existing.kind}: Meta exposes no *bylabels edge for ` +
          `${existing.kind} (only campaigns, ad sets and ads have one), so an ambiguous ` +
          `write of one cannot be resolved by search. Re-issuing ` +
          `may leave an orphan ${existing.kind} in ${existing.adAccountId} — which costs ` +
          `nothing and delivers nothing, unlike blocking the publish (attempt ` +
          `${existing.attempts})`,
      );
    } else {
      const outcome = await reconcileByLabel(graph, {
        adAccountId: existing.adAccountId,
        kind: existing.kind,
        labelId: existing.labelId,
        intentKey: key,
      });
      switch (outcome.status) {
        case 'FOUND':
          // The status travels into the audit trail: adopting an ARCHIVED or DELETED
          // object is still the right call (it exists, so creating another would
          // duplicate), but the tree is then pointing at something that will not
          // deliver, and nobody should have to re-derive that from Meta later.
          ledger.confirm(
            key,
            outcome.metaObjectId,
            'RECONCILE',
            `found on ${byLabelEdgeFor(existing.kind) ?? 'label search'} with ` +
              `effective_status=${outcome.object.effective_status ?? '<not returned>'}`,
          );
          break;
        case 'DUPLICATE': {
          const detail = `Found via ${byLabelEdgeFor(existing.kind) ?? 'label search'} on ${existing.adAccountId}.`;
          ledger.recordDuplicate(key, outcome.objectIds, detail);
          throw new DuplicateObjectError(key, outcome.objectIds, detail);
        }
        case 'ABSENT':
          ledger.fail(key, `reconciled ABSENT — ${outcome.note}`);
          break;
      }
    }
  }

  return ledger.reserve(intent);
}

// ---------------------------------------------------------------------------
// Layer 4 — classifying a write failure
// ---------------------------------------------------------------------------

/**
 * Did this failure definitely NOT create an object?
 *
 * The safe default is "we do not know", because the expensive mistake is assuming a
 * lost request never landed. Only two things are certain:
 *
 * - SpendGuardError is raised in the transport before any socket is opened.
 * - A structured Meta error other than AMBIGUOUS means Meta parsed the request and
 *   rejected it — a throttle, an auth failure, a blocked account, a bad parameter.
 *
 * With two carve-outs that look structured but are not: the client synthesises
 * `code: -1` for a non-OK HTTP response with no error body, and any 5xx may have been
 * generated by an edge *after* the write reached Meta.
 */
export function isDefinitelyNotSent(err: unknown): boolean {
  if (err instanceof SpendGuardError) return true;
  if (err instanceof MetaApiError) {
    if (err.code === -1) return false; // synthetic code: no verdict from Meta at all
    if (err.httpStatus >= 500) return false; // an edge 5xx can follow a successful write
    return err.disposition !== 'AMBIGUOUS';
  }
  return false;
}

/**
 * Records the outcome of a failed write against the ledger, choosing FAILED or
 * AMBIGUOUS from the error itself, and naming the actual cause in the reason so that
 * nobody has to reconstruct it at 3am.
 */
export function recordWriteFailure(ledger: IntentLedger, key: string, err: unknown): IntentRecord {
  const reason = describeFailure(err);
  return isDefinitelyNotSent(err) ? ledger.fail(key, reason) : ledger.markAmbiguous(key, reason);
}

function describeFailure(err: unknown): string {
  if (err instanceof MetaApiError) {
    return (
      `${err.disposition} ${err.code}${err.subcode !== undefined ? `/${err.subcode}` : ''} ` +
      `HTTP ${err.httpStatus}${err.fbtraceId ? ` fbtrace ${err.fbtraceId}` : ''}: ` +
      // body.message, not err.message — the latter already prefixes the code and
      // disposition, and a doubled prefix is noise in a log nobody is watching live.
      `${err.body.message}${err.body.error_user_msg ? ` — ${err.body.error_user_msg}` : ''}`
    );
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return `non-Error thrown: ${String(err)}`;
}
