import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  BY_LABEL_EDGES,
  DuplicateObjectError,
  INTENT_KEY_VERSION,
  IntentKeyError,
  IntentLedger,
  IntentModeError,
  IntentTransitionError,
  LedgerConcurrentWriteError,
  LedgerCorruptError,
  ReconcileMismatchError,
  ReconcileUnsupportedError,
  UnreconciledWriteError,
  byLabelEdgeFor,
  canonicalJson,
  ensureIntentLabel,
  extractIntentKey,
  intentKey,
  intentLabelName,
  isDefinitelyNotSent,
  reconcileAndReserve,
  reconcileByLabel,
  recordWriteFailure,
  stampIntentKey,
  type GraphClient,
  type IntentKind,
  type LabelledObject,
  type PublishIntent,
} from '../src/meta/idempotency.ts';
import { MetaApiError } from '../src/meta/errors.ts';
import { SpendGuardError } from '../src/meta/client.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'intent-ledger-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

let seq = 0;
function ledgerPath(): string {
  seq += 1;
  return join(ROOT, `run-${seq}`, 'intents.jsonl');
}

/** A clock the test drives by hand — nothing in the module may reach for Date.now(). */
function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const BASE: PublishIntent = {
  brandId: 'acme',
  adAccountId: 'act_1234567890',
  kind: 'campaign',
  role: 'primary',
  mode: 'LIVE',
  params: { name: 'Acme Q4', objective: 'OUTCOME_SALES', special_ad_categories: [] },
};

function intent(over: Partial<PublishIntent> = {}): PublishIntent {
  return { ...BASE, ...over };
}

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

interface FakeGraph extends GraphClient {
  gets: Array<{ path: string; params: Record<string, string> }>;
  posts: Array<{ path: string; params: Record<string, string> }>;
}

function fakeGraph(opts: {
  found?: LabelledObject[];
  labelId?: string;
  onGet?: () => never;
} = {}): FakeGraph {
  const gets: FakeGraph['gets'] = [];
  const posts: FakeGraph['posts'] = [];
  return {
    gets,
    posts,
    async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
      gets.push({ path, params });
      if (opts.onGet) opts.onGet();
      return { data: opts.found ?? [] } as T;
    },
    async post<T>(path: string, params: Record<string, string>): Promise<T> {
      posts.push({ path, params });
      return { id: opts.labelId ?? 'label_1' } as T;
    },
  };
}

// ---------------------------------------------------------------------------
// Layer 1 — the canonicaliser and the intent key
// ---------------------------------------------------------------------------

test('canonicalisation is insensitive to object key order', () => {
  assert.equal(
    canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } }),
    canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 }),
  );
});

test('null and undefined values are dropped, but empty containers survive', () => {
  assert.equal(canonicalJson({ a: 1, b: null, c: undefined }), canonicalJson({ a: 1 }));
  // special_ad_categories: [] is required on every campaign create and is NOT the same
  // intent as omitting it — a dropped empty array would be a hard #100 at publish.
  assert.notEqual(canonicalJson({ special_ad_categories: [] }), canonicalJson({}));
  assert.equal(canonicalJson({ special_ad_categories: [] }), '{"special_ad_categories":[]}');
});

test('array order is preserved; it is semantic on the wire', () => {
  assert.notEqual(canonicalJson(['a', 'b']), canonicalJson(['b', 'a']));
});

test('float noise and negative zero are normalised', () => {
  assert.equal(canonicalJson({ v: 0.1 + 0.2 }), canonicalJson({ v: 0.3 }));
  assert.equal(canonicalJson({ v: -0 }), canonicalJson({ v: 0 }));
  assert.equal(canonicalJson({ v: 1.0000001 }), canonicalJson({ v: 1 }));
});

test('a JSON-valued param string is canonicalised as structure, not as text', () => {
  // targeting/object_story_spec go over the wire as JSON strings whose key order is an
  // accident of how the publish module happened to build the object.
  const a = JSON.stringify({ geo_locations: { countries: ['GB'] }, age_min: 18 });
  const b = JSON.stringify({ age_min: 18, geo_locations: { countries: ['GB'] } });
  assert.notEqual(a, b);
  assert.equal(canonicalJson({ targeting: a }), canonicalJson({ targeting: b }));
});

test('a JSON-valued string does not collide with the equivalent structure', () => {
  assert.notEqual(canonicalJson({ t: '{"a":1}' }), canonicalJson({ t: { a: 1 } }));
});

test('a string that merely starts with a brace is left alone', () => {
  assert.equal(canonicalJson({ t: '{not json' }), '{"t":"{not json"}');
});

test('attempt-scoped keys are refused loudly rather than dropped silently', () => {
  for (const key of ['created_at', 'nonce', 'fbtrace_id', 'attempt']) {
    assert.throws(
      () => canonicalJson({ name: 'x', [key]: 'v' }),
      (err: unknown) => err instanceof IntentKeyError && err.message.includes(key),
      `${key} must be rejected — it would give every retry a different key`,
    );
  }
});

test('secrets are refused, because the ledger is plain text on disk', () => {
  assert.throws(() => canonicalJson({ access_token: 'EAAG...' }), IntentKeyError);
  assert.throws(() => canonicalJson({ appsecret_proof: 'deadbeef' }), IntentKeyError);
});

test('bigints, Dates, NaN and array holes are refused with a specific reason', () => {
  assert.throws(() => canonicalJson({ id: 23851234567890123n }), /exceed 2\^53/);
  assert.throws(() => canonicalJson({ at: new Date(0) }), /property of the attempt/);
  assert.throws(() => canonicalJson({ v: Number.NaN }), /not representable/);
  assert.throws(() => canonicalJson({ v: [1, null, 2] }), /shift every later element/);
});

test('the intent key is a versioned digest of the whole identity tuple', () => {
  const material = canonicalJson([
    INTENT_KEY_VERSION,
    BASE.brandId,
    BASE.adAccountId,
    BASE.kind,
    BASE.role,
    BASE.mode,
    BASE.params,
  ]);
  const expected = createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32);
  assert.equal(intentKey(BASE), expected);
  assert.match(intentKey(BASE), /^[0-9a-f]{32}$/);
});

test('every identity component changes the key — including the runtime mode', () => {
  const base = intentKey(BASE);
  const variants: Array<[string, PublishIntent]> = [
    ['brand', intent({ brandId: 'other' })],
    ['account', intent({ adAccountId: 'act_9' })],
    ['kind', intent({ kind: 'adset' })],
    ['role', intent({ role: 'variant-b' })],
    // SIMULATE confirms a fabricated object id; sharing a key with LIVE would make the
    // first real publish return the fake id and silently never go live.
    ['mode', intent({ mode: 'SIMULATE' })],
    ['params', intent({ params: { ...BASE.params, name: 'different' } })],
  ];
  for (const [label, v] of variants) {
    assert.notEqual(intentKey(v), base, `${label} must be part of the key`);
  }
});

test('the same logical write hashes identically however it was built', () => {
  const a = intent({ params: { objective: 'OUTCOME_SALES', name: 'Acme Q4', special_ad_categories: [], daily_budget: null } });
  const b = intent({ params: { special_ad_categories: [], name: 'Acme Q4', objective: 'OUTCOME_SALES' } });
  assert.equal(intentKey(a), intentKey(b));
});

test('empty identity components are refused — they would collide distinct intents', () => {
  assert.throws(() => intentKey(intent({ brandId: '' })), /brandId/);
  assert.throws(() => intentKey(intent({ role: '   ' })), /role/);
});

// ---------------------------------------------------------------------------
// Name and label stamping
// ---------------------------------------------------------------------------

test('the name stamp round-trips and survives truncation', () => {
  const key = intentKey(BASE);
  const stamped = stampIntentKey('Acme Q4 prospecting', key);
  assert.equal(extractIntentKey(stamped), key);

  const long = stampIntentKey('x'.repeat(500), key);
  assert.ok(long.length <= 255, `stamped name was ${long.length} chars`);
  // Only the human-readable prefix is sacrificed; recovery depends on the stamp.
  assert.equal(extractIntentKey(long), key);

  assert.equal(extractIntentKey('a campaign with no stamp'), undefined);
  assert.equal(intentLabelName(key), `idem:${key}`);
});

// ---------------------------------------------------------------------------
// Layer 2 — the ledger
// ---------------------------------------------------------------------------

test('reserve writes a durable row before anything else happens', () => {
  const path = ledgerPath();
  const c = clock();
  const ledger = new IntentLedger({ path, now: c.now });

  const res = ledger.reserve(BASE);
  assert.equal(res.status, 'PROCEED');
  assert.ok(existsSync(path), 'the row must be on disk before the network call');

  const lines = readLines(path);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.['event'], 'RESERVE');
  assert.equal(lines[0]?.['at'], 1_700_000_000_000, 'timestamps come from the injected clock');
  assert.equal(lines[0]?.['canonicaliser'], INTENT_KEY_VERSION);
  assert.deepEqual(lines[0]?.['params'], BASE.params);
});

test('a confirmed intent is never issued twice', () => {
  const path = ledgerPath();
  const ledger = new IntentLedger({ path, now: clock().now });
  const res = ledger.reserve(BASE);
  assert.equal(res.status, 'PROCEED');
  if (res.status !== 'PROCEED') return;
  res.confirm('23851234567890123');

  const again = ledger.reserve(BASE);
  assert.equal(again.status, 'ALREADY_CONFIRMED');
  if (again.status !== 'ALREADY_CONFIRMED') return;
  assert.equal(again.metaObjectId, '23851234567890123');
  // A replay must not append anything: RESERVE + CONFIRM only.
  assert.equal(readLines(path).length, 2);
});

test('state survives a process restart, replayed from the log', () => {
  const path = ledgerPath();
  const first = new IntentLedger({ path, now: clock().now });
  const res = first.reserve(BASE);
  if (res.status !== 'PROCEED') return assert.fail('expected PROCEED');
  res.confirm('999');

  const reopened = new IntentLedger({ path, now: clock().now });
  const again = reopened.reserve(BASE);
  assert.equal(again.status, 'ALREADY_CONFIRMED');
  assert.equal(reopened.get(intentKey(BASE))?.attempts, 1);
});

test('an unresolved PENDING row blocks every retry — this is the guard', () => {
  const path = ledgerPath();
  const ledger = new IntentLedger({ path, now: clock().now });
  ledger.reserve(BASE);

  // A crash between reserve and the response leaves PENDING, which is exactly the
  // ambiguous window: the write may already have created a spending object.
  assert.throws(() => ledger.reserve(BASE), UnreconciledWriteError);

  const err = (() => {
    try {
      new IntentLedger({ path, now: clock().now }).reserve(BASE);
    } catch (e) {
      return e as Error;
    }
    return undefined;
  })();
  assert.ok(err instanceof UnreconciledWriteError);
  assert.match(err.message, /campaignsbylabels/, 'the error must name the reconcile call to run');
  assert.match(err.message, /no label recorded/, 'and say why no label id is available');
});

test('an AMBIGUOUS row blocks every retry until reconciliation clears it', () => {
  const ledger = new IntentLedger({ path: ledgerPath(), now: clock().now });
  const res = ledger.reserve(BASE);
  if (res.status !== 'PROCEED') return assert.fail('expected PROCEED');
  res.markAmbiguous('Meta 2 [AMBIGUOUS]: temporary service issue');

  assert.throws(() => ledger.reserve(BASE), UnreconciledWriteError);
  assert.equal(ledger.unresolved().length, 1);
});

test('a definitively failed write may be re-attempted, and attempts accumulate', () => {
  const path = ledgerPath();
  const ledger = new IntentLedger({ path, now: clock().now });
  const first = ledger.reserve(BASE);
  if (first.status !== 'PROCEED') return assert.fail('expected PROCEED');
  first.fail('Meta 100 [PERMANENT]: missing special_ad_categories');
  assert.equal(ledger.unresolved().length, 0, 'a definitive failure needs no reconciliation');

  const second = ledger.reserve(BASE);
  assert.equal(second.status, 'PROCEED');
  if (second.status !== 'PROCEED') return;
  assert.equal(second.attempt, 2);
  // The fresh reservation is itself unresolved until it lands or fails.
  assert.equal(ledger.unresolved().length, 1);
});

test('confirming one intent against two different object ids is a double-create alarm', () => {
  const ledger = new IntentLedger({ path: ledgerPath(), now: clock().now });
  const res = ledger.reserve(BASE);
  if (res.status !== 'PROCEED') return assert.fail('expected PROCEED');
  res.confirm('111');
  assert.doesNotThrow(() => res.confirm('111'), 'the same id twice is a harmless replay');
  assert.throws(() => res.confirm('222'), DuplicateObjectError);
});

test('the ledger refuses ids that are not strings — Meta ids exceed 2^53', () => {
  const ledger = new IntentLedger({ path: ledgerPath(), now: clock().now });
  const res = ledger.reserve(BASE);
  if (res.status !== 'PROCEED') return assert.fail('expected PROCEED');
  assert.throws(() => res.confirm(''), IntentKeyError);
  assert.throws(() => ledger.confirm(intentKey(BASE), 23851234567890123 as unknown as string), IntentKeyError);
});

test('resolving an intent that was never reserved is a loud programming error', () => {
  const ledger = new IntentLedger({ path: ledgerPath(), now: clock().now });
  assert.throws(() => ledger.confirm('deadbeef', '1'), /reserve\(\) the intent first|no such intent/);
});

test('a torn final line is tolerated; anything earlier is not', () => {
  const path = ledgerPath();
  const ledger = new IntentLedger({ path, now: clock().now });
  ledger.reserve(BASE);
  const good = readFileSync(path, 'utf8').trimEnd();

  // A crash mid-append can only tear the last line.
  const torn = join(ROOT, 'torn.jsonl');
  writeFileSync(torn, `${good}\n{"v":1,"event":"CONF`);
  const recovered = new IntentLedger({ path: torn, now: clock().now });
  assert.equal(recovered.warnings.length, 1);
  assert.match(recovered.warnings[0] ?? '', /torn final line/);
  assert.equal(recovered.get(intentKey(BASE))?.state, 'PENDING');

  // Tolerating the fragment is only half the job: the recovery run appends, and if the
  // torn bytes are still there the new record is welded onto them into one unparseable
  // non-final line — after which no run can ever load the ledger again.
  recovered.fail(intentKey(BASE), 'reconciled: never issued');
  const reloaded = new IntentLedger({ path: torn, now: clock().now });
  assert.equal(reloaded.warnings.length, 0, 'the torn tail must not survive the repair');
  assert.equal(reloaded.get(intentKey(BASE))?.state, 'FAILED');
  assert.equal(readLines(torn).length, 2);

  // Damage anywhere else means the file has been edited, and guessing past it risks
  // publishing a write that is already live.
  const mangled = join(ROOT, 'mangled.jsonl');
  writeFileSync(mangled, `${good}\nnot json at all\n${good}\n`);
  assert.throws(() => new IntentLedger({ path: mangled, now: clock().now }), LedgerCorruptError);
});

test('an event for an unreserved key means the log is incoherent', () => {
  const orphan = join(ROOT, 'orphan.jsonl');
  writeFileSync(orphan, `${JSON.stringify({ v: 1, event: 'CONFIRM', key: 'abc', at: 1, metaObjectId: '1', via: 'WRITE' })}\n`);
  assert.throws(() => new IntentLedger({ path: orphan, now: clock().now }), LedgerCorruptError);
});

// ---------------------------------------------------------------------------
// Layer 3 — reconciliation
// ---------------------------------------------------------------------------

test('only campaigns, ad sets and ads have a *bylabels edge', () => {
  assert.equal(byLabelEdgeFor('campaign'), BY_LABEL_EDGES.campaign);
  assert.equal(byLabelEdgeFor('adset'), 'adsetsbylabels');
  assert.equal(byLabelEdgeFor('ad'), 'adsbylabels');
  for (const kind of ['adcreative', 'advideo', 'adimage'] as IntentKind[]) {
    assert.equal(byLabelEdgeFor(kind), undefined, `${kind} has no label-search edge`);
  }
});

test('reconcile issues the verified *bylabels query and reads the status field', async () => {
  const graph = fakeGraph({ found: [{ id: '123', name: 'x', effective_status: 'PAUSED' }] });
  const outcome = await reconcileByLabel(graph, {
    adAccountId: 'act_1',
    kind: 'ad',
    labelId: 'label_9',
  });
  assert.equal(outcome.status, 'FOUND');
  if (outcome.status !== 'FOUND') return;
  assert.equal(outcome.metaObjectId, '123');

  const call = graph.gets[0];
  assert.equal(call?.path, 'act_1/adsbylabels');
  assert.equal(call?.params['ad_label_ids'], '["label_9"]');
  assert.equal(call?.params['operator'], 'ALL');
  // ARCHIVED/DELETED objects vanish from default list queries but still exist, so the
  // status must be visible to whoever reads the outcome.
  assert.match(call?.params['fields'] ?? '', /effective_status/);
});

test('absence is reported as "not visible", with the unverified caveat attached', async () => {
  const outcome = await reconcileByLabel(fakeGraph({ found: [] }), {
    adAccountId: 'act_1',
    kind: 'campaign',
    labelId: 'label_9',
  });
  assert.equal(outcome.status, 'ABSENT');
  if (outcome.status !== 'ABSENT') return;
  assert.match(outcome.note, /UNVERIFIED/);
});

test('reconcile refuses object kinds Meta gives no label-search edge for', async () => {
  await assert.rejects(
    () => reconcileByLabel(fakeGraph(), { adAccountId: 'act_1', kind: 'adcreative', labelId: 'l' }),
    ReconcileUnsupportedError,
  );
});

test('a numeric id in a *bylabels response is rejected, not silently trusted', async () => {
  const graph: GraphClient = {
    async get<T>(): Promise<T> {
      return { data: [{ id: 23851234567890123 }] } as T;
    },
    async post<T>(): Promise<T> {
      return {} as T;
    },
  };
  await assert.rejects(
    () => reconcileByLabel(graph, { adAccountId: 'act_1', kind: 'ad', labelId: 'l' }),
    /exceed 2\^53|non-empty string/,
  );
});

test('an object stamped with a different intent key is never adopted', async () => {
  const mine = intentKey(BASE);
  const theirs = 'f'.repeat(32);
  const graph = fakeGraph({ found: [{ id: '1', name: stampIntentKey('Someone else', theirs) }] });
  await assert.rejects(
    () => reconcileByLabel(graph, { adAccountId: 'act_1', kind: 'ad', labelId: 'l', intentKey: mine }),
    ReconcileMismatchError,
  );
});

test('an unstamped name is accepted — labels are what survive renames', async () => {
  const graph = fakeGraph({ found: [{ id: '1', name: 'Renamed by the optimiser' }] });
  const outcome = await reconcileByLabel(graph, {
    adAccountId: 'act_1',
    kind: 'ad',
    labelId: 'l',
    intentKey: intentKey(BASE),
  });
  assert.equal(outcome.status, 'FOUND');
});

test('the label id is persisted before it is returned, and created only once', async () => {
  const path = ledgerPath();
  const ledger = new IntentLedger({ path, now: clock().now });
  const key = intentKey(BASE);
  ledger.reserve(BASE);

  const graph = fakeGraph({ labelId: 'label_42' });
  assert.equal(await ensureIntentLabel(graph, ledger, key), 'label_42');
  assert.equal(graph.posts[0]?.path, 'act_1234567890/adlabels');
  assert.equal(graph.posts[0]?.params['name'], `idem:${key}`);
  assert.equal(readLines(path).at(-1)?.['event'], 'LABEL');
  assert.equal(new IntentLedger({ path, now: clock().now }).get(key)?.labelId, 'label_42');

  assert.equal(await ensureIntentLabel(graph, ledger, key), 'label_42');
  assert.equal(graph.posts.length, 1, 'a known label must not be re-created');
});

test('a label id is never silently replaced — recovery queries by the stored one', () => {
  const ledger = new IntentLedger({ path: ledgerPath(), now: clock().now });
  const key = intentKey(BASE);
  ledger.reserve(BASE);
  ledger.recordLabel(key, 'label_1');
  assert.throws(() => ledger.recordLabel(key, 'label_2'), IntentKeyError);
});

test('recovery: an unresolved intent with no label never touched the network', async () => {
  const path = ledgerPath();
  const first = new IntentLedger({ path, now: clock().now });
  first.reserve(BASE); // crash here — before the label existed

  const reopened = new IntentLedger({ path, now: clock().now });
  const graph = fakeGraph({
    onGet: () => {
      throw new Error('reconciliation must not be needed when no label was ever created');
    },
  });
  const res = await reconcileAndReserve(reopened, graph, BASE);
  assert.equal(res.status, 'PROCEED');
  if (res.status !== 'PROCEED') return;
  assert.equal(res.attempt, 2);
  assert.equal(graph.gets.length, 0);
});

test('recovery: an ambiguous write whose object exists is confirmed, not re-issued', async () => {
  const path = ledgerPath();
  const c = clock();
  const ledger = new IntentLedger({ path, now: c.now });
  const key = intentKey(BASE);
  const res = ledger.reserve(BASE);
  if (res.status !== 'PROCEED') return assert.fail('expected PROCEED');
  await ensureIntentLabel(fakeGraph({ labelId: 'label_7' }), ledger, key);
  // Meta code 2: the write may have landed before the failure surfaced.
  res.markAmbiguous('Meta 2 [AMBIGUOUS]: temporary service issue');

  const graph = fakeGraph({ found: [{ id: '23851234567890123', effective_status: 'PAUSED' }] });
  const reopened = new IntentLedger({ path, now: c.now });
  const outcome = await reconcileAndReserve(reopened, graph, BASE);

  assert.equal(outcome.status, 'ALREADY_CONFIRMED');
  if (outcome.status !== 'ALREADY_CONFIRMED') return;
  assert.equal(outcome.metaObjectId, '23851234567890123');
  assert.equal(graph.gets[0]?.params['ad_label_ids'], '["label_7"]');
  const last = readLines(path).at(-1);
  assert.equal(last?.['event'], 'CONFIRM');
  assert.equal(last?.['via'], 'RECONCILE', 'the audit trail must say how we learned the id');
  // Adopting the object is right either way, but an ARCHIVED one will not deliver and
  // that has to be readable from the ledger rather than re-derived from Meta.
  assert.match(String(last?.['note']), /effective_status=PAUSED/);
});

test('recovery: an ambiguous write with no object on Meta becomes safe to re-issue', async () => {
  const path = ledgerPath();
  const ledger = new IntentLedger({ path, now: clock().now });
  const key = intentKey(BASE);
  const res = ledger.reserve(BASE);
  if (res.status !== 'PROCEED') return assert.fail('expected PROCEED');
  await ensureIntentLabel(fakeGraph({ labelId: 'label_7' }), ledger, key);
  res.markAmbiguous('socket hang up');

  const outcome = await reconcileAndReserve(ledger, fakeGraph({ found: [] }), BASE);
  assert.equal(outcome.status, 'PROCEED');
  if (outcome.status !== 'PROCEED') return;
  assert.equal(outcome.attempt, 2);
  assert.equal(outcome.labelId, 'label_7', 'the same label is reused on the retry');
  const failLine = readLines(path).find((l) => l['event'] === 'FAIL');
  assert.match(String(failLine?.['reason']), /reconciled ABSENT/);
  assert.match(String(failLine?.['reason']), /UNVERIFIED/);
});

test('recovery: two objects under one label is an alarm that stays latched', async () => {
  const path = ledgerPath();
  const ledger = new IntentLedger({ path, now: clock().now });
  const key = intentKey(BASE);
  const res = ledger.reserve(BASE);
  if (res.status !== 'PROCEED') return assert.fail('expected PROCEED');
  await ensureIntentLabel(fakeGraph({ labelId: 'label_7' }), ledger, key);
  res.markAmbiguous('Meta 1 [AMBIGUOUS]: unknown error');

  const graph = fakeGraph({ found: [{ id: '200' }, { id: '100' }] });
  await assert.rejects(() => reconcileAndReserve(ledger, graph, BASE), DuplicateObjectError);

  assert.equal(ledger.get(key)?.state, 'DUPLICATE');
  // The alarm must not clear itself on the next pass.
  assert.throws(() => ledger.reserve(BASE), DuplicateObjectError);
  await assert.rejects(() => reconcileAndReserve(ledger, graph, BASE), DuplicateObjectError);

  // Only a human decides which of two spending objects survives.
  assert.throws(() => ledger.resolveDuplicate(key, '999', 'wrong id'), IntentKeyError);
  const resolved = ledger.resolveDuplicate(key, '100', 'archived 200, kept lowest id');
  assert.equal(resolved.state, 'CONFIRMED');
  assert.equal(resolved.metaObjectId, '100');
  assert.equal(resolved.lastReason, 'archived 200, kept lowest id');
  assert.deepEqual(resolved.duplicateObjectIds, ['200', '100'], 'the alarm stays in the audit trail');
  assert.equal((await reconcileAndReserve(ledger, graph, BASE)).status, 'ALREADY_CONFIRMED');
});

test('recovery: a confirmed intent short-circuits without any network call', async () => {
  const ledger = new IntentLedger({ path: ledgerPath(), now: clock().now });
  const res = ledger.reserve(BASE);
  if (res.status !== 'PROCEED') return assert.fail('expected PROCEED');
  res.confirm('42');
  const graph = fakeGraph({ onGet: () => { throw new Error('must not query Meta'); } });
  assert.equal((await reconcileAndReserve(ledger, graph, BASE)).status, 'ALREADY_CONFIRMED');
});

test('recovery of a creative re-issues instead of stranding the tree, and records why', async () => {
  const path = ledgerPath();
  const ledger = new IntentLedger({ path, now: clock().now });
  const creative = intent({ kind: 'adcreative', role: 'creative' });
  const key = intentKey(creative);
  const res = ledger.reserve(creative);
  if (res.status !== 'PROCEED') return assert.fail('expected PROCEED');
  await ensureIntentLabel(fakeGraph({ labelId: 'label_c' }), ledger, key);
  res.markAmbiguous('socket hang up');

  // There is no adcreativesbylabels edge, so there is nothing to ask Meta. Blocking
  // forever would need a human to hand-edit an append-only ledger at 3am; the orphan
  // this risks instead costs $0 and delivers nothing.
  const graph = fakeGraph({ onGet: () => { throw new Error('there is no edge to query'); } });
  const outcome = await reconcileAndReserve(ledger, graph, creative);
  assert.equal(outcome.status, 'PROCEED');
  if (outcome.status !== 'PROCEED') return;
  assert.equal(outcome.attempt, 2);
  assert.equal(graph.gets.length, 0, 'no query can be made for a kind with no edge');

  const reason = String(readLines(path).find((l) => l['event'] === 'FAIL')?.['reason']);
  assert.match(reason, /no \*bylabels edge for adcreative/);
  assert.match(reason, /orphan adcreative/, 'the residual risk must be named, not hidden');

  // The low-level query still refuses outright — only the recovery orchestration is
  // allowed to decide that an orphan beats a stranded publish.
  await assert.rejects(
    () => reconcileByLabel(fakeGraph(), { adAccountId: 'act_1', kind: 'adcreative', labelId: 'l' }),
    (err: unknown) =>
      err instanceof ReconcileUnsupportedError && /does not spend money on its own/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Layer 4 — classifying a write failure
// ---------------------------------------------------------------------------

test('failure classification defaults to "we do not know"', () => {
  // Definitely never reached Meta.
  assert.equal(isDefinitelyNotSent(new SpendGuardError('refused in the transport')), true);
  assert.equal(isDefinitelyNotSent(new MetaApiError({ message: 'bad param', code: 100 }, 400)), true);
  assert.equal(isDefinitelyNotSent(new MetaApiError({ message: 'throttled', code: 4 }, 400)), true);
  assert.equal(isDefinitelyNotSent(new MetaApiError({ message: 'token dead', code: 190 }, 400)), true);

  // Meta codes 1 and 2 — the write may have landed before the failure.
  assert.equal(isDefinitelyNotSent(new MetaApiError({ message: 'unknown', code: 1 }, 500)), false);
  assert.equal(isDefinitelyNotSent(new MetaApiError({ message: 'transient', code: 2 }, 200)), false);

  // The client synthesises code -1 when an HTTP failure carried no error body: that is
  // no verdict at all, and a 5xx can be generated by an edge after the write landed.
  assert.equal(isDefinitelyNotSent(new MetaApiError({ message: '<html>502</html>', code: -1 }, 502)), false);
  assert.equal(isDefinitelyNotSent(new MetaApiError({ message: 'gateway', code: 100 }, 504)), false);

  // Sockets, timeouts, OOM: unknown, therefore ambiguous.
  assert.equal(isDefinitelyNotSent(new TypeError('fetch failed')), false);
  assert.equal(isDefinitelyNotSent('nope'), false);
});

test('recordWriteFailure routes to FAILED or AMBIGUOUS and names the cause', () => {
  const ledger = new IntentLedger({ path: ledgerPath(), now: clock().now });
  const key = intentKey(BASE);
  ledger.reserve(BASE);

  const permanent = recordWriteFailure(
    ledger,
    key,
    new MetaApiError({ message: 'special_ad_categories is required', code: 100 }, 400),
  );
  assert.equal(permanent.state, 'FAILED');
  assert.match(permanent.lastReason ?? '', /PERMANENT 100 HTTP 400/);
  assert.match(permanent.lastReason ?? '', /special_ad_categories/);

  ledger.reserve(BASE); // FAILED is retryable
  const ambiguous = recordWriteFailure(
    ledger,
    key,
    new MetaApiError({ message: 'temporary', code: 2, fbtrace_id: 'Abc123' }, 500),
  );
  assert.equal(ambiguous.state, 'AMBIGUOUS');
  assert.match(ambiguous.lastReason ?? '', /AMBIGUOUS 2 HTTP 500 fbtrace Abc123/);
  assert.throws(() => ledger.reserve(BASE), UnreconciledWriteError);
});

// ---------------------------------------------------------------------------
// Regressions out of a settled state — the paths that re-create a live object
// ---------------------------------------------------------------------------

test('a failure recorded after the write was confirmed is refused, not obeyed', () => {
  const path = ledgerPath();
  const ledger = new IntentLedger({ path, now: clock().now });
  const key = intentKey(BASE);
  const res = ledger.reserve(BASE);
  if (res.status !== 'PROCEED') return assert.fail('expected PROCEED');
  res.confirm('23851234567890123');

  // The plausible caller: one try-block around the POST and the verification that
  // follows it. FAILED is retryable, so obeying this would re-create a campaign that
  // already exists and is already spending.
  assert.throws(
    () => ledger.fail(key, 'advantage_state came back DISABLED'),
    (err: unknown) => err instanceof IntentTransitionError && /already spending|money-spending|CONFIRMED/.test(err.message),
  );
  assert.throws(
    () => recordWriteFailure(ledger, key, new MetaApiError({ message: 'temporary', code: 2 }, 500)),
    IntentTransitionError,
  );

  assert.equal(ledger.get(key)?.state, 'CONFIRMED');
  assert.equal(ledger.get(key)?.metaObjectId, '23851234567890123');
  assert.equal(readLines(path).length, 2, 'a refused event must not reach the disk');
  assert.equal(ledger.reserve(BASE).status, 'ALREADY_CONFIRMED');
});

test('a ledger that regresses a confirmed intent is corrupt, not replayable', () => {
  const path = ledgerPath();
  const ledger = new IntentLedger({ path, now: clock().now });
  const res = ledger.reserve(BASE);
  if (res.status !== 'PROCEED') return assert.fail('expected PROCEED');
  res.confirm('23851234567890123');
  const rows = readFileSync(path, 'utf8').trimEnd().split('\n');
  const reserve = rows[0] ?? assert.fail('no RESERVE row');
  const confirm = rows[1] ?? assert.fail('no CONFIRM row');

  // Hand-edited, or written by a second process working from a stale view. Either way
  // the replay must not hand back a record that says "safe to create".
  for (const tail of [
    JSON.stringify({ v: 1, event: 'FAIL', key: intentKey(BASE), at: 2, reason: 'edited in' }),
    reserve,
  ]) {
    const damaged = join(ROOT, `regress-${tail.length}-${Math.random()}.jsonl`);
    writeFileSync(damaged, `${reserve}\n${confirm}\n${tail}\n`);
    assert.throws(() => new IntentLedger({ path: damaged, now: clock().now }), LedgerCorruptError);
  }
});

test('a latched duplicate can only be cleared by resolveDuplicate', () => {
  const ledger = new IntentLedger({ path: ledgerPath(), now: clock().now });
  const key = intentKey(BASE);
  const res = ledger.reserve(BASE);
  if (res.status !== 'PROCEED') return assert.fail('expected PROCEED');
  ledger.recordDuplicate(key, ['200', '100'], 'two campaigns under one label');

  // Confirming an arbitrary id would silently pick a winner between two objects that
  // are both spending money.
  assert.throws(() => ledger.confirm(key, '100'), IntentTransitionError);
  assert.throws(() => ledger.fail(key, 'give up'), IntentTransitionError);
  assert.equal(ledger.get(key)?.state, 'DUPLICATE');
  assert.equal(ledger.resolveDuplicate(key, '100', 'archived 200').state, 'CONFIRMED');
});

// ---------------------------------------------------------------------------
// Two writers on one ledger
// ---------------------------------------------------------------------------

test('a second publisher on the same ledger is refused before it can reserve', () => {
  const path = ledgerPath();
  const a = new IntentLedger({ path, now: clock().now });
  const b = new IntentLedger({ path, now: clock().now }); // an overlapping cron run

  assert.equal(a.reserve(BASE).status, 'PROCEED');
  // Without this check both instances read "nothing reserved", both proceed, and two
  // campaigns start spending — while the replay afterwards shows a single record.
  assert.throws(() => b.reserve(BASE), LedgerConcurrentWriteError);
  assert.equal(readLines(path).length, 1);
});

test('the concurrency check fires before the label row, so before the object POST', async () => {
  const path = ledgerPath();
  const a = new IntentLedger({ path, now: clock().now });
  const key = intentKey(BASE);
  a.reserve(BASE);

  // b loaded a consistent file, so its own reserve was legitimate; a then wrote again.
  const b = new IntentLedger({ path, now: clock().now });
  await ensureIntentLabel(fakeGraph({ labelId: 'label_a' }), a, key);

  const graph = fakeGraph({ labelId: 'label_b' });
  await assert.rejects(() => ensureIntentLabel(graph, b, key), LedgerConcurrentWriteError);
  // The ordering contract holds: the refusal lands before the object write is issued.
  assert.equal(graph.posts.length, 1, 'only the label POST happened');
});

// ---------------------------------------------------------------------------
// Ledger rows are validated field by field, not just as JSON
// ---------------------------------------------------------------------------

test('a row missing an identity field is corrupt, not a record full of undefined', () => {
  const path = ledgerPath();
  const ledger = new IntentLedger({ path, now: clock().now });
  ledger.reserve(BASE);
  const row = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>;

  const cases: Array<[string, Record<string, unknown>]> = [
    ['adAccountId', { ...row, adAccountId: undefined }],
    ['kind', { ...row, kind: 'campaigns' }],
    ['mode', { ...row, mode: 'PRODUCTION' }],
    ['attempt', { ...row, attempt: 0 }],
    ['metaObjectId', { v: 1, event: 'CONFIRM', key: row['key'], at: 2, via: 'WRITE' }],
  ];
  for (const [field, damaged] of cases) {
    const file = join(ROOT, `bad-${field}.jsonl`);
    writeFileSync(file, `${JSON.stringify(damaged)}\n`);
    // Without per-field validation an adAccountId of undefined reconciles against
    // "GET undefined/campaignsbylabels", finds nothing, and reports "safe to create".
    assert.throws(
      () => new IntentLedger({ path: file, now: clock().now }),
      (err: unknown) => err instanceof LedgerCorruptError && err.message.includes(field),
      `a row with a bad ${field} must be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// Modes that cannot create objects
// ---------------------------------------------------------------------------

test('VALIDATE is refused at the label, naming the reason rather than "no id"', async () => {
  const ledger = new IntentLedger({ path: ledgerPath(), now: clock().now });
  const validating = intent({ mode: 'VALIDATE' });
  ledger.reserve(validating);

  // execution_options=['validate_only'] creates nothing, so the label POST could never
  // return an id and the intent could never be made recoverable.
  const graph = { ...fakeGraph(), mode: 'VALIDATE' as const };
  await assert.rejects(
    () => ensureIntentLabel(graph, ledger, intentKey(validating)),
    (err: unknown) => err instanceof IntentModeError && /validate_only/.test(err.message),
  );
  assert.equal(graph.posts.length, 0, 'the pointless POST must not be issued');
});

test('a SIMULATE intent is reconciled without spending a real read', async () => {
  const path = ledgerPath();
  const ledger = new IntentLedger({ path, now: clock().now });
  const simulated = intent({ mode: 'SIMULATE' });
  const key = intentKey(simulated);
  const res = ledger.reserve(simulated);
  if (res.status !== 'PROCEED') return assert.fail('expected PROCEED');
  await ensureIntentLabel(fakeGraph({ labelId: 'simulated_ab12' }), ledger, key);
  res.markAmbiguous('worker killed mid-dry-run');

  // SIMULATE returns a fabricated id without opening a socket, so nothing can exist on
  // Meta to find — and a dry run must not burn reads against the live account.
  const graph = fakeGraph({ onGet: () => { throw new Error('a dry run must not query Meta'); } });
  const outcome = await reconcileAndReserve(ledger, graph, simulated);
  assert.equal(outcome.status, 'PROCEED');
  assert.equal(graph.gets.length, 0);
  assert.match(
    String(readLines(path).find((l) => l['event'] === 'FAIL')?.['reason']),
    /SIMULATE mode never creates Meta objects/,
  );
});
