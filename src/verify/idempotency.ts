/**
 * Capability probe for src/meta/idempotency.ts.
 *
 * Not a unit test. The question here is whether the intent ledger actually does its job
 * — stop the same logical write from creating two money-spending Meta objects — when it
 * is driven end to end, through the real reserve -> label -> POST -> confirm lifecycle,
 * against a fake Graph client that answers with Meta's documented shapes:
 *
 *   POST act_<id>/adlabels            -> {"id":"23848520000000123"}
 *   POST act_<id>/campaigns           -> {"id":"120210123456780123"}
 *   GET  act_<id>/campaignsbylabels   -> {"data":[{id,name,effective_status}],"paging":{...}}
 *   errors                            -> MetaApiError over a real GraphErrorBody
 *
 * The observable asserted throughout is the one that costs money: how many create POSTs
 * were issued, and how many objects exist on the fake account afterwards.
 *
 * Run: node --experimental-strip-types src/verify/idempotency.ts
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MetaClient, SpendGuardError, type RuntimeMode } from '../meta/client.ts';
import { MetaApiError, type GraphErrorBody } from '../meta/errors.ts';
import {
  DuplicateObjectError,
  ensureIntentLabel,
  extractIntentKey,
  IntentKeyError,
  IntentLedger,
  IntentTransitionError,
  INTENT_KEY_VERSION,
  canonicalJson,
  intentKey,
  isDefinitelyNotSent,
  LedgerConcurrentWriteError,
  LedgerCorruptError,
  reconcileAndReserve,
  recordWriteFailure,
  stampIntentKey,
  UnreconciledWriteError,
  type GraphClient,
  type IntentKind,
  type PublishIntent,
} from '../meta/idempotency.ts';

// ---------------------------------------------------------------------------
// Report contract
// ---------------------------------------------------------------------------

export interface Check {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
  // Set when the check could not run for an environmental reason (no assets
  // assigned, no API key, binary missing) rather than because the code is wrong.
  blockedBy?: string;
}

export interface VerifyReport {
  module: string;
  checks: Check[];
}

class SkipSignal extends Error {
  readonly blockedBy: string;
  constructor(blockedBy: string, detail: string) {
    super(detail);
    this.name = 'SkipSignal';
    this.blockedBy = blockedBy;
  }
}

function skip(blockedBy: string, detail: string): never {
  throw new SkipSignal(blockedBy, detail);
}

function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

async function expectThrow<T>(fn: () => Promise<T> | T, message: string): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error(`${message}: nothing was thrown`);
}

// ---------------------------------------------------------------------------
// Realistic fixtures
// ---------------------------------------------------------------------------

const AD_ACCOUNT = 'act_1782234567890123';
const OTHER_ACCOUNT = 'act_9982234567890124';
const PAGE_ID = '102938475610293';
const IG_USER_ID = '17841400000000001';

/** Campaign create params as publish.ts builds them: every value a string, JSON blobs stringified. */
function campaignParams(over: Record<string, string> = {}): Record<string, unknown> {
  return {
    objective: 'OUTCOME_SALES',
    special_ad_categories: '[]',
    buying_type: 'AUCTION',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    daily_budget: '5000',
    status: 'PAUSED',
    ...over,
  };
}

const TARGETING_A = JSON.stringify({
  geo_locations: { countries: ['GB'], location_types: ['home', 'recent'] },
  age_min: 25,
  age_max: 54,
  targeting_automation: { advantage_audience: 1 },
});

/** The same targeting, built in a different key order and with different whitespace. */
const TARGETING_B = `{ "age_max": 54, "targeting_automation": { "advantage_audience": 1 },
  "age_min": 25, "geo_locations": { "location_types": ["home", "recent"], "countries": ["GB"] } }`;

function adSetParams(targeting: string): Record<string, unknown> {
  return {
    campaign_id: '120210123456780123',
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'OFFSITE_CONVERSIONS',
    promoted_object: JSON.stringify({ pixel_id: '1234567890123456', custom_event_type: 'PURCHASE' }),
    targeting,
    attribution_spec: JSON.stringify([{ event_type: 'CLICK_THROUGH', window_days: 7 }]),
    status: 'PAUSED',
  };
}

function intent(over: Partial<PublishIntent> = {}): PublishIntent {
  return {
    brandId: 'acme-coffee',
    adAccountId: AD_ACCOUNT,
    kind: 'campaign',
    role: 'prospecting/uk/broad',
    mode: 'LIVE',
    params: campaignParams(),
    ...over,
  };
}

/** Meta error bodies, copied in shape from the documented/observed responses. */
function graphError(body: Partial<GraphErrorBody> & { code: number }, httpStatus: number): MetaApiError {
  return new MetaApiError(
    {
      message: 'An unknown error occurred',
      type: 'OAuthException',
      fbtrace_id: 'AbCdEfGhIjKlMnOpQrStUv',
      ...body,
    },
    httpStatus,
  );
}

const ERR_UNKNOWN_1 = (): MetaApiError =>
  graphError({ code: 1, error_subcode: 99, message: 'An unknown error occurred' }, 500);
const ERR_TEMPORARY_2 = (): MetaApiError =>
  graphError(
    { code: 2, message: 'An unexpected error has occurred. Please retry your request later.' },
    500,
  );
const ERR_INVALID_100 = (): MetaApiError =>
  graphError(
    {
      code: 100,
      error_subcode: 1487390,
      message: 'Invalid parameter',
      error_user_title: 'Ad set budget too low',
      error_user_msg: 'The minimum daily budget for this ad set is $1.00.',
    },
    400,
  );
const ERR_THROTTLED_17 = (): MetaApiError =>
  graphError({ code: 17, message: 'User request limit reached' }, 400);
const ERR_SYNTHETIC = (): MetaApiError =>
  graphError({ code: -1, message: 'HTTP 502 with no error body' }, 502);

// ---------------------------------------------------------------------------
// A faithful fake of the subset of the Graph API this module touches
// ---------------------------------------------------------------------------

type CreateBehaviour =
  | 'OK'
  /** The object is created, then the response is lost — Meta code 2 over HTTP 500. */
  | 'AMBIGUOUS_LANDED'
  /** Nothing is created, but the failure is indistinguishable from the above. */
  | 'AMBIGUOUS_LOST'
  /** Two objects created under one label — a double-create that already happened. */
  | 'DOUBLE_LANDED'
  /** Meta parsed and rejected the request; nothing was created. */
  | 'PERMANENT';

interface FakeObject {
  id: string;
  kind: IntentKind;
  name: string;
  labelIds: string[];
  effective_status: string;
}

const EDGE_KIND: Readonly<Record<string, IntentKind>> = {
  campaignsbylabels: 'campaign',
  adsetsbylabels: 'adset',
  adsbylabels: 'ad',
};

const CREATE_KIND: Readonly<Record<string, IntentKind>> = {
  campaigns: 'campaign',
  adsets: 'adset',
  ads: 'ad',
  adcreatives: 'adcreative',
};

class FakeMeta implements GraphClient {
  mode: RuntimeMode = 'LIVE';
  readonly gets: Array<{ path: string; params: Record<string, string> }> = [];
  readonly posts: Array<{ path: string; params: Record<string, string> }> = [];
  readonly objects: FakeObject[] = [];
  createBehaviour: CreateBehaviour = 'OK';
  /** Runs before a create is applied — used to inspect the ledger file at that instant. */
  onCreate: ((path: string, params: Record<string, string>) => void) | undefined;
  /** Forces the next created object's effective_status (ARCHIVED, PAUSED, ...). */
  nextStatus = 'PAUSED';
  private labelSeq = 0;
  private objectSeq = 0;

  get createPosts(): Array<{ path: string; params: Record<string, string> }> {
    return this.posts.filter((p) => !p.path.endsWith('/adlabels'));
  }

  async get<T>(path: string, params: Record<string, string> = {}, _ctx?: { adAccountId?: string }): Promise<T> {
    this.gets.push({ path, params: { ...params } });
    const m = /^(act_[0-9]+)\/([a-z]+bylabels)$/.exec(path);
    if (!m) throw new Error(`FakeMeta: unexpected GET ${path}`);
    const edge = m[2] ?? '';
    const kind = EDGE_KIND[edge];
    if (!kind) throw new Error(`FakeMeta: no such edge ${edge}`);
    if (params['operator'] !== 'ALL') throw new Error(`FakeMeta: operator must be ALL, got ${params['operator']}`);
    const wanted = JSON.parse(params['ad_label_ids'] ?? '[]') as string[];
    const fields = (params['fields'] ?? 'id').split(',');
    const hits = this.objects.filter(
      (o) => o.kind === kind && wanted.every((id) => o.labelIds.includes(id)),
    );
    // Meta returns only the requested fields, plus a paging envelope.
    const data = hits.map((o) => {
      const row: Record<string, string> = { id: o.id };
      if (fields.includes('name')) row['name'] = o.name;
      if (fields.includes('effective_status')) row['effective_status'] = o.effective_status;
      return row;
    });
    return { data, paging: { cursors: { before: 'MAZDZD', after: 'MAZDZD' } } } as T;
  }

  async post<T>(
    path: string,
    params: Record<string, string>,
    _ctx?: { adAccountId?: string; idempotencyKey?: string },
  ): Promise<T> {
    this.posts.push({ path, params: { ...params } });

    if (this.mode === 'SIMULATE') {
      // Mirrors MetaClient.post in SIMULATE: a fabricated id, no socket opened.
      return { id: `simulated_${this.objectSeq++}`, __simulated: true } as T;
    }

    if (path.endsWith('/adlabels')) {
      this.labelSeq += 1;
      return { id: `2384852000000${String(this.labelSeq).padStart(4, '0')}` } as T;
    }

    const edge = path.split('/').pop() ?? '';
    const kind = CREATE_KIND[edge];
    if (!kind) throw new Error(`FakeMeta: unexpected POST ${path}`);
    this.onCreate?.(path, params);

    const create = (): string => {
      this.objectSeq += 1;
      const id = `1202101234567${String(80000 + this.objectSeq)}`;
      const labels = (JSON.parse(params['adlabels'] ?? '[]') as Array<{ id?: string }>)
        .map((l) => l.id)
        .filter((l): l is string => typeof l === 'string');
      this.objects.push({
        id,
        kind,
        name: params['name'] ?? '',
        labelIds: labels,
        effective_status: this.nextStatus,
      });
      return id;
    };

    switch (this.createBehaviour) {
      case 'OK':
        return { id: create() } as T;
      case 'AMBIGUOUS_LANDED':
        create();
        throw ERR_TEMPORARY_2();
      case 'DOUBLE_LANDED':
        create();
        create();
        throw ERR_TEMPORARY_2();
      case 'AMBIGUOUS_LOST':
        throw ERR_UNKNOWN_1();
      case 'PERMANENT':
        throw ERR_INVALID_100();
    }
  }
}

// ---------------------------------------------------------------------------
// The publish driver — what a caller of this module is supposed to do
// ---------------------------------------------------------------------------

class SimulatedCrash extends Error {
  constructor(where: string) {
    super(`simulated process death ${where}`);
    this.name = 'SimulatedCrash';
  }
}

interface PublishOptions {
  baseName?: string;
  /** Die after the label is durable but before the object POST — a killed process. */
  crashAfterLabel?: boolean;
  /** Die after the POST lands but before confirm() — the classic lost response. */
  crashBeforeConfirm?: boolean;
}

interface PublishResult {
  status: 'CREATED' | 'ALREADY_CONFIRMED';
  key: string;
  metaObjectId: string;
}

/**
 * The reserve -> label -> POST -> confirm lifecycle, in the order the module's contract
 * requires. Everything the probe drives goes through here so that no check quietly
 * exercises a shortcut a real publisher would not take.
 */
async function publishOne(
  ledger: IntentLedger,
  graph: FakeMeta,
  publishIntent: PublishIntent,
  opts: PublishOptions = {},
): Promise<PublishResult> {
  const reservation = await reconcileAndReserve(ledger, graph, publishIntent);
  if (reservation.status === 'ALREADY_CONFIRMED') {
    return { status: 'ALREADY_CONFIRMED', key: reservation.key, metaObjectId: reservation.metaObjectId };
  }

  const labelId = await ensureIntentLabel(graph, ledger, reservation.key);
  if (opts.crashAfterLabel) throw new SimulatedCrash('after the label, before the object POST');

  const edge = publishIntent.kind === 'campaign' ? 'campaigns' : `${publishIntent.kind}s`;
  const name = stampIntentKey(opts.baseName ?? `AUTO|${publishIntent.brandId}|${publishIntent.role}`, reservation.key);

  try {
    const res = await graph.post<{ id?: unknown }>(
      `${publishIntent.adAccountId}/${edge}`,
      {
        ...(publishIntent.params as Record<string, string>),
        name,
        adlabels: JSON.stringify([{ id: labelId }]),
      },
      { adAccountId: publishIntent.adAccountId, idempotencyKey: reservation.key },
    );
    const id = res.id;
    must(typeof id === 'string' && id !== '', 'the fake returned no object id');
    if (opts.crashBeforeConfirm) throw new SimulatedCrash('after the POST landed, before confirm()');
    reservation.confirm(id as string);
    return { status: 'CREATED', key: reservation.key, metaObjectId: id as string };
  } catch (err) {
    if (err instanceof SimulatedCrash) throw err; // a crash records nothing, by definition
    recordWriteFailure(ledger, reservation.key, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Workspace {
  dir: string;
  ledgerPath: (name?: string) => string;
  ledger: (name?: string) => IntentLedger;
  clock: () => number;
}

function workspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'verify-idem-'));
  let t = 1_764_000_000_000;
  const clock = (): number => (t += 1000);
  return {
    dir,
    clock,
    ledgerPath: (name = 'intents.jsonl') => join(dir, name),
    ledger: (name = 'intents.jsonl') => new IntentLedger({ path: join(dir, name), now: clock }),
  };
}

function readRows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function record(checks: Check[], name: string, fn: () => Promise<string>): Promise<void> {
  try {
    checks.push({ name, status: 'PASS', detail: await fn() });
  } catch (err) {
    if (err instanceof SkipSignal) {
      checks.push({ name, status: 'SKIP', detail: err.message, blockedBy: err.blockedBy });
      return;
    }
    checks.push({
      name,
      status: 'FAIL',
      detail: err instanceof Error ? `${err.name}: ${err.message}` : `non-Error thrown: ${String(err)}`,
    });
  }
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

export async function run(): Promise<VerifyReport> {
  const checks: Check[] = [];
  const ws = workspace();

  try {
    // -- Lifecycle -----------------------------------------------------------

    await record(checks, 'full lifecycle: reserve -> label -> POST -> confirm creates exactly one campaign', async () => {
      const graph = new FakeMeta();
      const ledger = ws.ledger('happy.jsonl');
      const it = intent();
      const out = await publishOne(ledger, graph, it);

      eq(out.status, 'CREATED', 'first publish should create');
      eq(graph.createPosts.length, 1, 'exactly one create POST');
      eq(graph.objects.length, 1, 'exactly one object on the account');
      const rec = ledger.get(out.key);
      must(rec, 'no ledger record after a successful publish');
      eq(rec.state, 'CONFIRMED', 'ledger state after a successful publish');
      eq(rec.metaObjectId, out.metaObjectId, 'ledger holds the Meta id');
      const rows = readRows(ws.ledgerPath('happy.jsonl'));
      eq(rows.map((r) => r['event']).join(','), 'RESERVE,LABEL,CONFIRM', 'on-disk row order');
      const posted = graph.createPosts[0];
      must(posted, 'no create POST recorded');
      eq(
        extractIntentKey(posted.params['name'] ?? ''),
        out.key,
        'the created object carries the intent stamp in its name',
      );
      return (
        `1 create POST, 1 object ${out.metaObjectId}, ledger CONFIRMED; ` +
        `rows RESERVE,LABEL,CONFIRM fsynced to disk; name stamped [idem:${out.key}]`
      );
    });

    await record(checks, 'the LABEL row is durable on disk before the object POST is issued', async () => {
      const graph = new FakeMeta();
      const path = ws.ledgerPath('ordering.jsonl');
      const ledger = ws.ledger('ordering.jsonl');
      let seenAtPostTime: Array<Record<string, unknown>> = [];
      let attachedLabel = '';
      graph.onCreate = (_p, params) => {
        seenAtPostTime = readRows(path);
        attachedLabel = (JSON.parse(params['adlabels'] ?? '[]') as Array<{ id: string }>)[0]?.id ?? '';
      };
      await publishOne(ledger, graph, intent({ role: 'ordering-contract' }));

      const events = seenAtPostTime.map((r) => r['event']);
      must(events.includes('RESERVE'), 'RESERVE was not on disk when the object POST was issued');
      must(events.includes('LABEL'), 'LABEL was not on disk when the object POST was issued');
      must(!events.includes('CONFIRM'), 'CONFIRM was on disk before the object existed');
      const labelRow = seenAtPostTime.find((r) => r['event'] === 'LABEL');
      eq(labelRow?.['labelId'], attachedLabel, 'the persisted label id is the one attached to the object');
      return (
        `at the instant of POST ${AD_ACCOUNT}/campaigns the file already held ` +
        `${events.join(',')} and the persisted labelId ${attachedLabel} is the one in adlabels=[{id}]`
      );
    });

    await record(checks, 'the same intent reserved twice in one process returns ALREADY_CONFIRMED, no second POST', async () => {
      const graph = new FakeMeta();
      const ledger = ws.ledger('twice.jsonl');
      const it = intent({ role: 'reserved-twice' });
      const first = await publishOne(ledger, graph, it);
      const second = await publishOne(ledger, graph, it);

      eq(second.status, 'ALREADY_CONFIRMED', 'second publish must not create');
      eq(second.metaObjectId, first.metaObjectId, 'the same object id comes back');
      eq(graph.createPosts.length, 1, 'still exactly one create POST');
      eq(graph.posts.filter((p) => p.path.endsWith('/adlabels')).length, 1, 'no second label POST');
      eq(graph.gets.length, 0, 'a confirmed intent asks Meta nothing');
      return `2 publish calls -> 1 create POST, 1 label POST, 0 GETs; both returned ${first.metaObjectId}`;
    });

    await record(checks, 'a process restart re-reads the ledger and still returns ALREADY_CONFIRMED', async () => {
      const graph = new FakeMeta();
      const it = intent({ role: 'restart' });
      const first = await publishOne(ws.ledger('restart.jsonl'), graph, it);
      // A brand new IntentLedger over the same file is exactly what the next process does.
      const revived = ws.ledger('restart.jsonl');
      eq(revived.warnings.length, 0, 'a clean ledger should load without warnings');
      const second = await publishOne(revived, graph, it);

      eq(second.status, 'ALREADY_CONFIRMED', 'a restarted process must not re-create');
      eq(second.metaObjectId, first.metaObjectId, 'the id survives the restart');
      eq(graph.createPosts.length, 1, 'still exactly one create POST across both processes');
      eq(graph.gets.length, 0, 'no network call needed to know it is done');
      return `across two IntentLedger instances over one file: 1 create POST, id ${first.metaObjectId} recovered from disk`;
    });

    // -- Crash recovery: the four reconcile cases ---------------------------

    await record(checks, 'a crash between reserve and response is detected as unreconciled and blocks a blind retry', async () => {
      const graph = new FakeMeta();
      const ledger = ws.ledger('crash.jsonl');
      const it = intent({ role: 'crash-blocks-retry' });
      const crash = await expectThrow(
        () => publishOne(ledger, graph, it, { crashAfterLabel: true }),
        'the simulated crash did not propagate',
      );
      must(crash instanceof SimulatedCrash, 'expected the simulated crash');

      const revived = ws.ledger('crash.jsonl');
      const unresolved = revived.unresolved();
      eq(unresolved.length, 1, 'the crashed intent should be unresolved after a restart');
      eq(unresolved[0]?.state, 'PENDING', 'a crash leaves the row PENDING');

      const refusal = await expectThrow(() => revived.reserve(it), 'a blind retry was allowed');
      must(refusal instanceof UnreconciledWriteError, `expected UnreconciledWriteError, got ${String(refusal)}`);
      must(
        refusal.message.includes('campaignsbylabels'),
        'the refusal must name the recovery query an operator can run',
      );
      eq(graph.createPosts.length, 0, 'nothing was created');
      return `restart saw 1 PENDING intent; ledger.reserve() threw UnreconciledWriteError naming the campaignsbylabels recovery query`;
    });

    await record(checks, 'reconcile case 1/4 — already CONFIRMED: no network call, original id returned', async () => {
      const graph = new FakeMeta();
      const it = intent({ role: 'reconcile-confirmed' });
      const first = await publishOne(ws.ledger('rc1.jsonl'), graph, it);
      const getsBefore = graph.gets.length;
      const again = await reconcileAndReserve(ws.ledger('rc1.jsonl'), graph, it);

      eq(again.status, 'ALREADY_CONFIRMED', 'a confirmed intent must short-circuit');
      eq(again.status === 'ALREADY_CONFIRMED' ? again.metaObjectId : '', first.metaObjectId, 'same id');
      eq(graph.gets.length, getsBefore, 'reconciliation must not query Meta for a confirmed intent');
      return `reconcileAndReserve returned ALREADY_CONFIRMED ${first.metaObjectId} with 0 additional GETs`;
    });

    await record(checks, 'reconcile case 2/4 — exactly one object found: adopted, no duplicate POST', async () => {
      const graph = new FakeMeta();
      const it = intent({ role: 'reconcile-found' });
      const ledger = ws.ledger('rc2.jsonl');

      // The write lands on Meta and the response is lost (code 2 over HTTP 500).
      graph.createBehaviour = 'AMBIGUOUS_LANDED';
      const failure = await expectThrow(() => publishOne(ledger, graph, it), 'the ambiguous failure vanished');
      must(failure instanceof MetaApiError && failure.code === 2, 'expected Meta code 2');
      eq(ledger.get(intentKey(it))?.state, 'AMBIGUOUS', 'an ambiguous failure must not be recorded as FAILED');
      eq(graph.objects.length, 1, 'the object really did land on Meta');

      // Next run: reconcile before doing anything.
      graph.createBehaviour = 'OK';
      const revived = ws.ledger('rc2.jsonl');
      const out = await publishOne(revived, graph, it);

      eq(out.status, 'ALREADY_CONFIRMED', 'the existing object must be adopted, not re-created');
      eq(out.metaObjectId, graph.objects[0]?.id, 'adopted the object that actually exists');
      eq(graph.createPosts.length, 1, 'no second create POST was issued');
      eq(graph.objects.length, 1, 'still exactly one object on the account');
      const rec = revived.get(out.key);
      eq(rec?.state, 'CONFIRMED', 'ledger state after adoption');
      must(
        (rec?.lastReason ?? '').includes('campaignsbylabels'),
        'the audit note should say how the id was learned',
      );
      const confirmRow = readRows(ws.ledgerPath('rc2.jsonl')).find((r) => r['event'] === 'CONFIRM');
      eq(confirmRow?.['via'], 'RECONCILE', 'the CONFIRM row must record that it came from reconciliation');
      return (
        `lost response over a landed write: 1 GET on campaignsbylabels adopted ${out.metaObjectId}, ` +
        `1 create POST total, CONFIRM via=RECONCILE (${String(rec?.lastReason).slice(0, 60)}…)`
      );
    });

    await record(checks, 'reconcile case 3/4 — more than one object found: alarms and stays latched', async () => {
      const graph = new FakeMeta();
      const it = intent({ role: 'reconcile-duplicate' });
      const ledger = ws.ledger('rc3.jsonl');

      graph.createBehaviour = 'DOUBLE_LANDED'; // a double-create that already happened
      await expectThrow(() => publishOne(ledger, graph, it), 'the double-create failure vanished');
      eq(graph.objects.length, 2, 'the fake really created two objects');

      graph.createBehaviour = 'OK';
      const revived = ws.ledger('rc3.jsonl');
      const alarm = await expectThrow(() => publishOne(revived, graph, it), 'a double-create did not alarm');
      must(alarm instanceof DuplicateObjectError, `expected DuplicateObjectError, got ${String(alarm)}`);
      eq(alarm.objectIds.length, 2, 'both ids must be reported');
      eq(revived.get(intentKey(it))?.state, 'DUPLICATE', 'the alarm must latch in the ledger');

      // A third run, in yet another process, must still refuse.
      const third = ws.ledger('rc3.jsonl');
      const still = await expectThrow(() => publishOne(third, graph, it), 'the latch did not hold across a restart');
      must(still instanceof DuplicateObjectError, 'the latch must survive a restart');
      eq(graph.createPosts.length, 1, 'no further create POST was issued while latched');
      eq(graph.objects.length, 2, 'nothing new was created');
      return (
        `2 objects under one label -> DuplicateObjectError (${alarm.objectIds.join(', ')}), ` +
        `state latched DUPLICATE and still refused after a restart`
      );
    });

    await record(checks, 'reconcile case 4/4 — no object found: safe to re-issue, exactly one object results', async () => {
      const graph = new FakeMeta();
      const it = intent({ role: 'reconcile-absent' });
      const ledger = ws.ledger('rc4.jsonl');

      graph.createBehaviour = 'AMBIGUOUS_LOST'; // code 1: may or may not have landed. It did not.
      await expectThrow(() => publishOne(ledger, graph, it), 'the ambiguous failure vanished');
      eq(ledger.get(intentKey(it))?.state, 'AMBIGUOUS', 'code 1 must be AMBIGUOUS, never FAILED');
      eq(graph.objects.length, 0, 'nothing landed');

      graph.createBehaviour = 'OK';
      const revived = ws.ledger('rc4.jsonl');
      const out = await publishOne(revived, graph, it);

      eq(out.status, 'CREATED', 'an absent object must be re-issued');
      eq(graph.objects.length, 1, 'exactly one object exists at the end');
      eq(graph.createPosts.length, 2, 'one failed create plus one successful create');
      const failRow = readRows(ws.ledgerPath('rc4.jsonl')).find(
        (r) => r['event'] === 'FAIL' && String(r['reason']).includes('ABSENT'),
      );
      must(failRow, 'the ABSENT reconciliation should be recorded as a FAIL row');
      must(
        String(failRow['reason']).includes('UNVERIFIED'),
        'the ABSENT caveat about ARCHIVED/DELETED visibility must be preserved in the ledger',
      );
      const labelPosts = graph.posts.filter((p) => p.path.endsWith('/adlabels'));
      eq(labelPosts.length, 1, 'the label from the first attempt is reused, not re-created');
      return (
        `code 1 with nothing landed: reconcile -> ABSENT -> FAIL -> re-issue; 1 object exists, ` +
        `label re-used across attempts (1 adlabels POST for 2 create attempts)`
      );
    });

    await record(checks, 'reconciliation issues the documented *bylabels query and reads effective_status', async () => {
      const graph = new FakeMeta();
      const it = intent({ role: 'query-shape' });
      const ledger = ws.ledger('shape.jsonl');
      graph.createBehaviour = 'AMBIGUOUS_LANDED';
      await expectThrow(() => publishOne(ledger, graph, it), 'no failure');
      graph.createBehaviour = 'OK';
      await publishOne(ws.ledger('shape.jsonl'), graph, it);

      const q = graph.gets[0];
      must(q, 'no GET was issued');
      eq(q.path, `${AD_ACCOUNT}/campaignsbylabels`, 'the verified edge path');
      eq(q.params['operator'], 'ALL', 'operator=ALL');
      const ids = JSON.parse(q.params['ad_label_ids'] ?? 'null') as unknown;
      must(Array.isArray(ids) && ids.length === 1 && typeof ids[0] === 'string', 'ad_label_ids must be a JSON array of strings');
      must((q.params['fields'] ?? '').includes('effective_status'), 'effective_status must be requested');
      return `GET ${q.path}?ad_label_ids=${q.params['ad_label_ids']}&operator=ALL&fields=${q.params['fields']}`;
    });

    await record(checks, 'an intent with no label id is reconciled without a network call (the ordering contract)', async () => {
      const graph = new FakeMeta();
      const ledger = ws.ledger('nolabel.jsonl');
      const it = intent({ role: 'no-label' });
      // Reserve, then die before the label exists: proof the object write was never issued.
      const r = ledger.reserve(it);
      must(r.status === 'PROCEED', 'expected PROCEED');

      const revived = ws.ledger('nolabel.jsonl');
      const out = await reconcileAndReserve(revived, graph, it);
      eq(out.status, 'PROCEED', 'a never-issued write is safe to re-attempt');
      eq(graph.gets.length, 0, 'no GET may be spent when the write provably never happened');
      const failRow = readRows(ws.ledgerPath('nolabel.jsonl')).find((r2) => r2['event'] === 'FAIL');
      must(
        String(failRow?.['reason']).includes('no ad label was ever recorded'),
        'the reason must state why no network call was needed',
      );
      eq(out.status === 'PROCEED' ? out.attempt : 0, 2, 'attempts accumulate across the recovery');
      return `PENDING with no LABEL row -> resolved offline (0 GETs), re-reserved as attempt 2`;
    });

    await record(checks, 'an ARCHIVED object under the intent label is adopted, with its status in the audit trail', async () => {
      const graph = new FakeMeta();
      const it = intent({ role: 'archived' });
      const ledger = ws.ledger('archived.jsonl');
      graph.nextStatus = 'ARCHIVED';
      graph.createBehaviour = 'AMBIGUOUS_LANDED';
      await expectThrow(() => publishOne(ledger, graph, it), 'no failure');
      graph.createBehaviour = 'OK';
      const revived = ws.ledger('archived.jsonl');
      const out = await publishOne(revived, graph, it);

      eq(out.status, 'ALREADY_CONFIRMED', 'an ARCHIVED object still means "do not create a second one"');
      eq(graph.objects.length, 1, 'nothing new created');
      must(
        (revived.get(out.key)?.lastReason ?? '').includes('effective_status=ARCHIVED'),
        'the archived status must be recorded, or the tree silently points at something that will not deliver',
      );
      return `ARCHIVED object adopted; ledger note carries effective_status=ARCHIVED so the dead tree is visible`;
    });

    await record(checks, 'an object whose name stamp belongs to another intent is never adopted', async () => {
      const graph = new FakeMeta();
      const it = intent({ role: 'mismatch' });
      const ledger = ws.ledger('mismatch.jsonl');
      graph.createBehaviour = 'AMBIGUOUS_LANDED';
      await expectThrow(() => publishOne(ledger, graph, it), 'no failure');
      // Somebody else's object is wearing our label.
      const foreignKey = intentKey(intent({ role: 'somebody-else' }));
      const obj = graph.objects[0];
      must(obj, 'no object');
      obj.name = stampIntentKey('Foreign campaign', foreignKey);

      graph.createBehaviour = 'OK';
      const revived = ws.ledger('mismatch.jsonl');
      const err = await expectThrow(() => publishOne(revived, graph, it), 'a foreign object was adopted');
      must(err instanceof Error && err.name === 'ReconcileMismatchError', `expected ReconcileMismatchError, got ${String(err)}`);
      eq(revived.get(intentKey(it))?.state, 'AMBIGUOUS', 'the intent stays blocked rather than binding to a stranger');
      eq(graph.createPosts.length, 1, 'no blind re-issue after the mismatch');
      return `object stamped [idem:${foreignKey.slice(0, 8)}…] refused; intent stays AMBIGUOUS and nothing was re-issued`;
    });

    // -- Ledger durability ---------------------------------------------------

    await record(checks, 'a torn final line is truncated, and the ledger stays loadable and appendable', async () => {
      const graph = new FakeMeta();
      const path = ws.ledgerPath('torn.jsonl');
      const it = intent({ role: 'torn' });
      await publishOne(ws.ledger('torn.jsonl'), graph, it);
      const good = readFileSync(path, 'utf8');
      // A crash mid-append leaves an incomplete record.
      writeFileSync(path, `${good}{"v":1,"event":"RESER`);

      const revived = ws.ledger('torn.jsonl');
      eq(revived.warnings.length, 1, 'the torn line must be reported, not swallowed');
      must(revived.warnings[0]?.includes('torn final line'), 'warning should name the torn line');
      eq(revived.get(intentKey(it))?.state, 'CONFIRMED', 'the complete records before the tear survive');
      // The file must still be appendable and re-readable afterwards.
      revived.reserve(intent({ role: 'after-torn' }));
      const again = ws.ledger('torn.jsonl');
      eq(again.warnings.length, 0, 'the truncated tail must not come back');
      eq(again.all().length, 2, 'both intents readable after the repair');
      return `torn tail truncated with a warning, prior records intact, next append clean (2 intents readable)`;
    });

    await record(checks, 'a final record that lost only its terminating newline does not weld onto the next append', async () => {
      const graph = new FakeMeta();
      const path = ws.ledgerPath('newline.jsonl');
      const it = intent({ role: 'lost-newline' });
      const first = await publishOne(ws.ledger('newline.jsonl'), graph, it);
      // The crash stopped writeSync one byte short: the CONFIRM record is complete and
      // parseable, but unterminated. It must NOT be discarded (it proves the object
      // exists) and must NOT be welded to the next record (that made the ledger
      // permanently unreadable — DEFECT, now fixed).
      const raw = readFileSync(path, 'utf8');
      must(raw.endsWith('\n'), 'precondition: the ledger normally ends with a newline');
      writeFileSync(path, raw.slice(0, -1));

      const revived = ws.ledger('newline.jsonl');
      must(
        revived.warnings.some((w) => w.includes('terminating newline')),
        'the unterminated tail must be reported',
      );
      eq(revived.get(first.key)?.state, 'CONFIRMED', 'the unterminated CONFIRM must be kept, not discarded');
      revived.reserve(intent({ role: 'after-newline-loss' }));

      const again = ws.ledger('newline.jsonl');
      eq(again.warnings.length, 0, 'the file must now be clean');
      eq(again.all().length, 2, 'both intents readable');
      eq(again.get(first.key)?.state, 'CONFIRMED', 'the confirmed intent survived the repair');
      const second = await publishOne(again, graph, it);
      eq(second.status, 'ALREADY_CONFIRMED', 'and it still protects the money after the repair');
      eq(graph.createPosts.length, 1, 'no duplicate create');
      return (
        `unterminated final CONFIRM kept + warned; next append prefixed a newline; ` +
        `reload clean, intent still ALREADY_CONFIRMED (regression check for the weld defect)`
      );
    });

    await record(checks, 'corruption before the final line is refused rather than guessed past', async () => {
      const graph = new FakeMeta();
      const path = ws.ledgerPath('corrupt.jsonl');
      await publishOne(ws.ledger('corrupt.jsonl'), graph, intent({ role: 'corrupt' }));
      const rows = readFileSync(path, 'utf8').split('\n');
      rows.splice(1, 0, '{"v":1,"event":"RESERVE","key":"' /* truncated mid-record */);
      writeFileSync(path, rows.join('\n'));

      const err = await expectThrow(() => ws.ledger('corrupt.jsonl'), 'a corrupt ledger loaded anyway');
      must(err instanceof LedgerCorruptError, `expected LedgerCorruptError, got ${String(err)}`);
      must(err.message.includes('line 2'), 'the corrupt line number must be named');
      return `an unparseable non-final line refuses to load: ${err.message.slice(0, 90)}…`;
    });

    await record(checks, 'a second publisher on the same ledger file is refused before it can reserve', async () => {
      const graph = new FakeMeta();
      const a = ws.ledger('race.jsonl');
      const b = ws.ledger('race.jsonl'); // both loaded the same (empty) view
      const itA = intent({ role: 'racer-a' });
      const itB = intent({ role: 'racer-b' });

      await publishOne(a, graph, itA);
      const err = await expectThrow(() => publishOne(b, graph, itB), 'the second publisher was allowed to reserve');
      must(err instanceof LedgerConcurrentWriteError, `expected LedgerConcurrentWriteError, got ${String(err)}`);
      eq(graph.createPosts.length, 1, 'the loser must be stopped before it can spend');
      eq(b.get(intentKey(itB)), undefined, 'the refused reserve must leave no phantom in-memory record');
      return `writer B refused at RESERVE (${err.message.slice(0, 70)}…) before any create POST; B has no phantom record`;
    });

    await record(checks, 'an in-flight publish tree survives a restart: confirmed campaign kept, pending ad set blocked', async () => {
      const graph = new FakeMeta();
      const ledger = ws.ledger('tree.jsonl');
      const campaign = intent({ role: 'tree/campaign' });
      const c = await publishOne(ledger, graph, campaign);
      const adset = intent({
        kind: 'adset',
        role: 'tree/adset',
        params: adSetParams(TARGETING_A),
      });
      await expectThrow(
        () => publishOne(ledger, graph, adset, { crashBeforeConfirm: true }),
        'the simulated crash vanished',
      );

      const revived = ws.ledger('tree.jsonl');
      eq(revived.get(c.key)?.state, 'CONFIRMED', 'the confirmed campaign must survive');
      eq(revived.get(intentKey(adset))?.state, 'PENDING', 'the crashed ad set must be PENDING');
      eq(revived.unresolved().length, 1, 'exactly one unresolved intent');
      // Recovery finds the ad set that really did land.
      const out = await publishOne(revived, graph, adset);
      eq(out.status, 'ALREADY_CONFIRMED', 'the landed ad set must be adopted');
      eq(graph.objects.filter((o) => o.kind === 'adset').length, 1, 'exactly one ad set exists');
      eq(graph.gets[0]?.path, `${AD_ACCOUNT}/adsetsbylabels`, 'the ad set edge was used');
      return `campaign CONFIRMED + ad set PENDING across a restart; ad set adopted via adsetsbylabels, 1 ad set total`;
    });

    // -- Intent identity -----------------------------------------------------

    await record(checks, 'JSON blob key order and whitespace do not change the intent key', async () => {
      const a = intent({ kind: 'adset', role: 'targeting', params: adSetParams(TARGETING_A) });
      const b = intent({ kind: 'adset', role: 'targeting', params: adSetParams(TARGETING_B) });
      eq(intentKey(a), intentKey(b), 'a targeting blob built in a different key order must hash the same');

      // Same, for the params record itself rather than a nested JSON string.
      const p1: Record<string, unknown> = { objective: 'OUTCOME_SALES', special_ad_categories: '[]', daily_budget: '5000' };
      const p2: Record<string, unknown> = { daily_budget: '5000', objective: 'OUTCOME_SALES', special_ad_categories: '[]', bid_cap: null };
      eq(intentKey(intent({ params: p1 })), intentKey(intent({ params: p2 })), 'key order / explicit null must not matter');

      // And a real publish must dedupe across the two spellings.
      const graph = new FakeMeta();
      const ledger = ws.ledger('order.jsonl');
      await publishOne(ledger, graph, a);
      const second = await publishOne(ledger, graph, b);
      eq(second.status, 'ALREADY_CONFIRMED', 'the reordered blob must be recognised as the same intent');
      eq(graph.createPosts.length, 1, 'no duplicate create from a reordered JSON blob');
      return `targeting blob in 2 key orders + whitespace -> one key ${intentKey(a)}; second publish deduped, 1 create POST`;
    });

    await record(checks, 'every identity component and every param change moves the key (2,400-variant sweep)', async () => {
      const keys = new Map<string, string>();
      const canon = new Map<string, string>();
      let n = 0;
      const kinds: IntentKind[] = ['campaign', 'adset', 'ad', 'adcreative'];
      const modes: RuntimeMode[] = ['SIMULATE', 'VALIDATE', 'STAGE', 'LIVE'];
      for (const brandId of ['acme-coffee', 'acme-coffee-uk', 'zenith']) {
        for (const adAccountId of [AD_ACCOUNT, OTHER_ACCOUNT]) {
          for (const kind of kinds) {
            for (const mode of modes) {
              for (const role of ['prospecting/uk', 'prospecting/us', 'retargeting/uk']) {
                for (const budget of [1000, 1001, 5000, 250000]) {
                  for (const objective of ['OUTCOME_SALES', 'OUTCOME_LEADS']) {
                    const it: PublishIntent = {
                      brandId,
                      adAccountId,
                      kind,
                      role,
                      mode,
                      params: campaignParams({ daily_budget: String(budget), objective }),
                    };
                    const k = intentKey(it);
                    const c = canonicalJson([brandId, adAccountId, kind, role, mode, it.params]);
                    const prevK = keys.get(k);
                    if (prevK !== undefined && prevK !== c) {
                      throw new Error(`KEY COLLISION between ${prevK} and ${c}`);
                    }
                    const prevC = canon.get(c);
                    if (prevC !== undefined) throw new Error(`canonical-form collision: ${c}`);
                    keys.set(k, c);
                    canon.set(c, k);
                    n += 1;
                  }
                }
              }
            }
          }
        }
      }
      eq(keys.size, n, 'every distinct intent must have its own key');
      eq(INTENT_KEY_VERSION, 'ik1', 'the key recipe version is mixed into every digest');
      return `${n} structurally distinct intents -> ${keys.size} distinct 128-bit keys, 0 collisions (recipe ${INTENT_KEY_VERSION})`;
    });

    await record(checks, 'adversarial collision attempts on the canonical encoding all stay distinct', async () => {
      const distinct: Array<[string, Record<string, unknown>]> = [
        ['string vs number', { daily_budget: '5000' }],
        ['number', { daily_budget: 5000 }],
        ['structure', { targeting: { countries: ['GB'] } }],
        ['json string of the same structure', { targeting: '{"countries":["GB"]}' }],
        ['delimiter injection in a key', { 'a":1,"b': 'x' }],
        ['the tuple it tries to impersonate', { a: 1, b: 'x' }],
        ['array order', { adlabels: [{ id: '1' }, { id: '2' }] }],
        ['array order reversed', { adlabels: [{ id: '2' }, { id: '1' }] }],
        ['empty array preserved', { special_ad_categories: [] }],
        ['empty object', { special_ad_categories: {} }],
        ['omitted entirely', {}],
        ['value split across keys', { a: '', b: 'xy' }],
        ['value split differently', { a: 'x', b: 'y' }],
        ['string "null"', { bid_cap: 'null' }],
        ['comma inside a value', { name: 'a,b' }],
        ['two keys spelling it', { name: 'a', extra: 'b' }],
      ];
      const seen = new Map<string, string>();
      for (const [label, params] of distinct) {
        const k = intentKey(intent({ params }));
        const clash = seen.get(k);
        if (clash !== undefined) throw new Error(`COLLISION: "${label}" and "${clash}" share an intent key`);
        seen.set(k, label);
      }

      // Documented equalities: these MUST collapse, and a publish must dedupe them.
      const same: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
        ['negative zero', { roas: -0 }, { roas: 0 }],
        ['float noise', { roas: 0.1 + 0.2 }, { roas: 0.3 }],
        ['null vs omitted', { bid_cap: null, name: 'x' }, { name: 'x' }],
        ['undefined vs omitted', { bid_cap: undefined, name: 'x' }, { name: 'x' }],
        ['json whitespace', { t: '{"a":1,"b":2}' }, { t: '{ "b": 2, "a": 1 }' }],
      ];
      for (const [label, a, b] of same) {
        eq(intentKey(intent({ params: a })), intentKey(intent({ params: b })), `${label} must collapse to one key`);
      }
      return (
        `${distinct.length} adversarial params (delimiter injection, string-vs-structure, empty containers, ` +
        `split values) -> ${seen.size} distinct keys; ${same.length} documented equalities collapse. ` +
        `Note: FLOAT_PRECISION=6 means values differing below 1e-6 collapse — irrelevant for Meta, whose ` +
        `money fields are integer minor units passed as strings.`
      );
    });

    await record(checks, 'SIMULATE and LIVE are different intents — a simulated id can never satisfy a LIVE publish', async () => {
      const graph = new FakeMeta();
      graph.mode = 'SIMULATE';
      const ledger = ws.ledger('modes.jsonl');
      const sim = intent({ role: 'mode-split', mode: 'SIMULATE' });
      const live = intent({ role: 'mode-split', mode: 'LIVE' });
      must(intentKey(sim) !== intentKey(live), 'SIMULATE and LIVE must not share a key');

      const dry = await publishOne(ledger, graph, sim);
      eq(dry.status, 'CREATED', 'the dry run should complete');
      must(dry.metaObjectId.startsWith('simulated_'), 'SIMULATE must confirm a fabricated id');
      eq(graph.objects.length, 0, 'SIMULATE creates nothing on the account');

      graph.mode = 'LIVE';
      const real = await publishOne(ws.ledger('modes.jsonl'), graph, live);
      eq(real.status, 'CREATED', 'the LIVE publish must actually publish');
      must(!real.metaObjectId.startsWith('simulated_'), 'the LIVE publish must not inherit the fake id');
      eq(graph.objects.length, 1, 'exactly one real object');

      // And an unresolved SIMULATE row must reconcile without spending a real read.
      graph.mode = 'SIMULATE';
      const stranded = intent({ role: 'mode-split/stranded', mode: 'SIMULATE' });
      const simLedger = ws.ledger('modes.jsonl');
      await expectThrow(
        () => publishOne(simLedger, graph, stranded, { crashBeforeConfirm: true }),
        'the simulated crash vanished',
      );
      eq(ws.ledger('modes.jsonl').get(intentKey(stranded))?.state, 'PENDING', 'the crashed dry run is PENDING');
      const getsBefore = graph.gets.length;
      const again = await reconcileAndReserve(ws.ledger('modes.jsonl'), graph, stranded);
      eq(again.status, 'PROCEED', 'a SIMULATE intent is always safe to re-issue');
      eq(graph.gets.length, getsBefore, 'a SIMULATE intent must not spend a real read to reconcile');
      return (
        `keys differ (${intentKey(sim).slice(0, 8)}… vs ${intentKey(live).slice(0, 8)}…); the SIMULATE run ` +
        `confirmed ${dry.metaObjectId} and the LIVE run still created ${real.metaObjectId}; ` +
        `SIMULATE reconciles with 0 GETs`
      );
    });

    await record(checks, 'Meta ids beyond 2^53 are refused rather than silently collapsed', async () => {
      const a = { page_id: 120210000000000001 };
      const b = { page_id: 120210000000000002 };
      const errA = await expectThrow(() => intentKey(intent({ params: a })), 'an unsafe integer was accepted');
      must(errA instanceof IntentKeyError, `expected IntentKeyError, got ${String(errA)}`);
      const errB = await expectThrow(() => intentKey(intent({ params: b })), 'an unsafe integer was accepted');
      must(errB instanceof IntentKeyError, 'both must be refused');
      // The correct spelling still works and stays distinct.
      const ks = new Set([
        intentKey(intent({ params: { page_id: '120210000000000001' } })),
        intentKey(intent({ params: { page_id: '120210000000000002' } })),
      ]);
      eq(ks.size, 2, 'string ids must remain distinguishable');
      // bigint is refused too, with a message that names the fix.
      const errBig = await expectThrow(() => intentKey(intent({ params: { page_id: 12021n } })), 'bigint accepted');
      must(errBig instanceof IntentKeyError, 'bigint must be refused');
      return (
        `120210000000000001 and …002 are the same double; both are now refused ` +
        `(IntentKeyError), the string spellings stay distinct (regression check for the silent-collapse defect)`
      );
    });

    await record(checks, 'a Map/Set/RegExp param is refused rather than hashed as {}', async () => {
      const exotic: Array<[string, unknown]> = [
        ['Map', new Map([['countries', 'GB']])],
        ['Set', new Set(['GB'])],
        ['RegExp', /GB/],
        ['Date', new Date(0)],
        ['class instance', new (class Spec { hidden = 1; get shown(): number { return this.hidden; } })()],
      ];
      const refused: string[] = [];
      for (const [label, value] of exotic) {
        const err = await expectThrow(
          () => intentKey(intent({ params: { targeting: value } })),
          `${label} was accepted into a content hash`,
        );
        must(err instanceof IntentKeyError, `${label}: expected IntentKeyError, got ${String(err)}`);
        refused.push(label);
      }
      // Plain objects, including null-prototype ones, still work.
      const plain = Object.assign(Object.create(null) as Record<string, unknown>, { countries: ['GB'] });
      must(canonicalJson({ targeting: plain }) === '{"targeting":{"countries":["GB"]}}', 'plain objects must still hash');
      return (
        `${refused.join(', ')} refused (each has no own enumerable state and would hash as {}, ` +
        `colliding every such intent onto one key); plain and null-prototype objects unaffected`
      );
    });

    await record(checks, 'attempt-scoped fields and secrets are refused, so the plain-text ledger cannot carry one', async () => {
      const volatile: Array<Record<string, unknown>> = [
        { access_token: 'EAAG…' },
        { appsecret_proof: 'deadbeef' },
        { created_at: 1764000000 },
        { request_id: 'abc' },
        { attempt: 2 },
        { targeting: '{"geo_locations":{"countries":["GB"]},"nonce":"x"}' }, // reaches inside JSON blobs
      ];
      for (const params of volatile) {
        const err = await expectThrow(() => intentKey(intent({ params })), `${JSON.stringify(params)} was accepted`);
        must(err instanceof IntentKeyError, `expected IntentKeyError for ${JSON.stringify(params)}`);
      }
      // And nothing token-shaped reaches the file in the normal path.
      const graph = new FakeMeta();
      const path = ws.ledgerPath('secrets.jsonl');
      await publishOne(ws.ledger('secrets.jsonl'), graph, intent({ role: 'secrets' }));
      const text = readFileSync(path, 'utf8');
      must(!/access_token|appsecret_proof/.test(text), 'the ledger file must never contain a credential field');
      return `${volatile.length} attempt-scoped/secret params refused (including one nested inside a JSON blob); ledger file carries no credential field`;
    });

    await record(checks, 'the persisted ledger row re-derives the same intent key after a restart', async () => {
      const graph = new FakeMeta();
      const it = intent({ kind: 'adset', role: 'roundtrip', params: adSetParams(TARGETING_A) });
      await publishOne(ws.ledger('roundtrip.jsonl'), graph, it);
      const revived = ws.ledger('roundtrip.jsonl');
      const rec = revived.get(intentKey(it));
      must(rec, 'no record after restart');
      const rederived = intentKey({
        brandId: rec.brandId,
        adAccountId: rec.adAccountId,
        kind: rec.kind,
        role: rec.role,
        mode: rec.mode,
        params: rec.params,
      });
      eq(rederived, rec.key, 'the key must be re-derivable from what was written to disk');
      const reserveRow = readRows(ws.ledgerPath('roundtrip.jsonl')).find((r) => r['event'] === 'RESERVE');
      eq(reserveRow?.['canonicaliser'], INTENT_KEY_VERSION, 'the row records which recipe produced the key');
      return `params survived a JSON round-trip through the file and re-hashed to the same key ${rec.key}`;
    });

    await record(checks, 'the intent stamp round-trips through a truncated object name', async () => {
      const key = intentKey(intent({ role: 'stamping' }));
      const long = 'AUTO|acme-coffee|prospecting/uk/broad|'.repeat(20);
      const stamped = stampIntentKey(long, key);
      eq(stamped.length, 255, 'the stamped name must sit at the cap');
      eq(extractIntentKey(stamped), key, 'the stamp survives truncation of the human-readable prefix');
      eq(extractIntentKey('AUTO|acme|no stamp here'), undefined, 'an unstamped name yields nothing');
      const tooTight = await expectThrow(() => stampIntentKey('x', key, 10), 'a hopeless maxLength was accepted');
      must(tooTight instanceof IntentKeyError, 'a maxLength with no room for the stamp must throw');
      // An autonomous system renames objects, so a base name arriving here pre-stamped is
      // expected. Two stamps used to resolve to the STALE one, which makes
      // reconcileByLabel reject our own object — DEFECT, now fixed by stripping.
      const second = intentKey(intent({ role: 'second' }));
      const doubled = stampIntentKey('AUTO|acme|prospecting [idem:' + key + ']', second);
      eq(extractIntentKey(doubled), second, 're-stamping must yield the CURRENT key, not the stale one');
      eq((doubled.match(/\[idem:/g) ?? []).length, 1, 'a name must never wear two stamps');
      return (
        `stamp survives truncation to ${stamped.length} chars and round-trips; a hopeless maxLength throws; ` +
        `re-stamping an already-stamped name replaces the old stamp instead of leaving a stale one that ` +
        `reconcileByLabel would read as somebody else's object (regression check)`
      );
    });

    // -- Failure classification ---------------------------------------------

    await record(checks, 'write failures are classified into FAILED vs AMBIGUOUS from real Meta error bodies', async () => {
      const cases: Array<[string, unknown, 'FAILED' | 'AMBIGUOUS']> = [
        ['code 1 (unknown, HTTP 500)', ERR_UNKNOWN_1(), 'AMBIGUOUS'],
        ['code 2 (temporary, HTTP 500)', ERR_TEMPORARY_2(), 'AMBIGUOUS'],
        ['code -1 (synthetic, no error body)', ERR_SYNTHETIC(), 'AMBIGUOUS'],
        ['code 100 (invalid parameter, HTTP 400)', ERR_INVALID_100(), 'FAILED'],
        ['code 17 (throttled, HTTP 400)', ERR_THROTTLED_17(), 'FAILED'],
        ['SpendGuardError (never left the process)', new SpendGuardError('blocked'), 'FAILED'],
        ['TypeError (a bug in our own code)', new TypeError('x is not a function'), 'AMBIGUOUS'],
        ['fetch failed (socket died)', new Error('fetch failed'), 'AMBIGUOUS'],
      ];
      const ledger = ws.ledger('classify.jsonl');
      const lines: string[] = [];
      for (const [label, err, expected] of cases) {
        const it = intent({ role: `classify/${label}` });
        const r = ledger.reserve(it);
        must(r.status === 'PROCEED', 'expected PROCEED');
        const rec = recordWriteFailure(ledger, r.key, err);
        eq(rec.state, expected, `${label} must be recorded ${expected}`);
        eq(isDefinitelyNotSent(err), expected === 'FAILED', `${label}: isDefinitelyNotSent disagrees`);
        lines.push(`${label}->${rec.state}`);
      }
      // The reason must name the real cause, not just "failed".
      const invalid = ledger.all().find((r) => r.role.includes('code 100'));
      must(
        (invalid?.lastReason ?? '').includes('minimum daily budget'),
        'the Meta error_user_msg must survive into the ledger reason',
      );
      return lines.join('; ');
    });

    await record(checks, 'a post-write verification failure cannot unsettle a confirmed intent', async () => {
      const graph = new FakeMeta();
      const ledger = ws.ledger('settled.jsonl');
      const it = intent({ role: 'settled' });
      const out = await publishOne(ledger, graph, it);

      // The classic caller bug: one try-block spanning the write AND the verification.
      const err = await expectThrow(
        () => recordWriteFailure(ledger, out.key, ERR_INVALID_100()),
        'a confirmed intent was moved back to FAILED',
      );
      must(err instanceof IntentTransitionError, `expected IntentTransitionError, got ${String(err)}`);
      eq(ledger.get(out.key)?.state, 'CONFIRMED', 'the intent must stay confirmed');
      // Confirming a second, different object id is a double-create alarm.
      const dup = await expectThrow(
        () => ledger.confirm(out.key, '120210999999999999'),
        'one intent was allowed to own two objects',
      );
      must(dup instanceof DuplicateObjectError, `expected DuplicateObjectError, got ${String(dup)}`);
      // And the file on disk never grew a contradictory row.
      const events = readRows(ws.ledgerPath('settled.jsonl')).map((r) => r['event']);
      eq(events.join(','), 'RESERVE,LABEL,CONFIRM', 'no contradictory row reached the disk');
      const revived = ws.ledger('settled.jsonl');
      eq(revived.get(out.key)?.state, 'CONFIRMED', 'and the restart still sees CONFIRMED');
      return `FAIL over a CONFIRMED intent refused (IntentTransitionError); a second object id refused (DuplicateObjectError); disk still RESERVE,LABEL,CONFIRM`;
    });

    await record(checks, 'a reconciliation that cannot reach Meta never opens the gate', async () => {
      const graph = new FakeMeta();
      const ledger = ws.ledger('badnet.jsonl');
      const it = intent({ role: 'reconcile-unreachable' });
      graph.createBehaviour = 'AMBIGUOUS_LANDED';
      await expectThrow(() => publishOne(ledger, graph, it), 'no failure');
      eq(graph.objects.length, 1, 'the object landed');

      // Now the reconciliation GET itself fails — throttled, then a dead socket.
      const failing: GraphClient = {
        mode: 'LIVE',
        get: async () => {
          throw ERR_THROTTLED_17();
        },
        post: async () => ({}) as never,
      };
      const revived = ws.ledger('badnet.jsonl');
      const err = await expectThrow(
        () => reconcileAndReserve(revived, failing, it),
        'a failed reconciliation silently allowed a re-issue',
      );
      must(err instanceof MetaApiError && err.code === 17, `expected the read failure to propagate, got ${String(err)}`);
      eq(ws.ledger('badnet.jsonl').get(intentKey(it))?.state, 'AMBIGUOUS', 'the intent must stay blocked');

      const dead: GraphClient = {
        mode: 'LIVE',
        get: async () => {
          throw new TypeError('fetch failed');
        },
        post: async () => ({}) as never,
      };
      await expectThrow(() => reconcileAndReserve(ws.ledger('badnet.jsonl'), dead, it), 'a dead socket opened the gate');
      eq(ws.ledger('badnet.jsonl').get(intentKey(it))?.state, 'AMBIGUOUS', 'still blocked after a dead socket');

      // And once Meta is reachable again, recovery adopts rather than duplicates.
      graph.createBehaviour = 'OK';
      const out = await publishOne(ws.ledger('badnet.jsonl'), graph, it);
      eq(out.status, 'ALREADY_CONFIRMED', 'recovery must adopt the landed object');
      eq(graph.objects.length, 1, 'exactly one object, still');
      return `code 17 and a dead socket during reconciliation both propagate and leave the intent AMBIGUOUS; no re-issue happened, and the later successful reconcile adopted ${out.metaObjectId}`;
    });

    await record(checks, 'the ledger record cannot be rewritten through the caller\'s params object', async () => {
      const ledger = ws.ledger('immutable.jsonl');
      const params = campaignParams();
      const it = intent({ role: 'immutable', params });
      const r = ledger.reserve(it);
      must(r.status === 'PROCEED', 'expected PROCEED');

      (params as Record<string, string>)['daily_budget'] = '9999900'; // caller edits after reserving
      const snap = ledger.get(r.key);
      must(snap, 'no record');
      eq(snap.params['daily_budget'], '5000', 'the ledger must hold what was reserved, not what the caller later wanted');
      (snap.params as Record<string, string>)['injected'] = 'yes'; // caller edits a returned snapshot
      eq(ledger.get(r.key)?.params['injected'], undefined, 'a returned snapshot must not be a live handle');

      const diskRow = readRows(ws.ledgerPath('immutable.jsonl'))[0];
      const diskParams = diskRow?.['params'] as Record<string, unknown>;
      eq(diskParams['daily_budget'], snap.params['daily_budget'], 'memory and the durable row must agree');
      return `post-reserve mutation of the caller's params and of a returned snapshot both left the record at daily_budget=5000, matching the on-disk row (regression check)`;
    });

    // -- The real Graph API --------------------------------------------------

    await record(checks, 'reconciliation against the real Graph API *bylabels edge', async () => {
      const { loadDotEnv } = (await import('../config.ts')) as typeof import('../config.ts');
      loadDotEnv(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'));
      const token = process.env['META_SYSTEM_USER_TOKEN'];
      const appId = process.env['META_APP_ID'];
      const appSecret = process.env['META_APP_SECRET'];
      if (!token || !appId || !appSecret) {
        skip('no Meta credentials in .env', 'META_SYSTEM_USER_TOKEN/META_APP_ID/META_APP_SECRET are not all set.');
      }
      const client = new MetaClient({
        appId: appId as string,
        appSecret: appSecret as string,
        accessToken: token as string,
        mode: 'SIMULATE', // GETs are always real; no write is possible from this probe
        fetchImpl: ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })) as typeof fetch,
      });
      let accounts: Array<{ id?: string }> = [];
      try {
        const res = await client.get<{ data?: Array<{ id?: string }> }>('me/adaccounts', { limit: '5' });
        accounts = res.data ?? [];
      } catch (err) {
        skip(
          'the live Graph API could not be reached',
          `GET /me/adaccounts failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (accounts.length === 0) {
        skip(
          'no ad account is assigned to the system user',
          `GET /me/adaccounts returned 0 accounts, so campaignsbylabels cannot be exercised against the real ` +
            `API. Everything above ran against a fake that mimics the documented response shapes. This unblocks ` +
            `once an ad account is assigned in Business Settings (read-only GET; no object was created).`,
        );
      }
      const acct = accounts[0]?.id ?? '';
      const { reconcileByLabel } = await import('../meta/idempotency.ts');
      const outcome = await reconcileByLabel(client, {
        adAccountId: acct,
        kind: 'campaign',
        labelId: '000000000000000', // a label that cannot exist
      });
      eq(outcome.status, 'ABSENT', 'a nonexistent label must reconcile to ABSENT against the real API');
      return `live read-only GET ${acct}/campaignsbylabels for a nonexistent label parsed as ABSENT`;
    });
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }

  return { module: 'src/meta/idempotency.ts', checks };
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const report = await run();
  const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const c of report.checks) {
    counts[c.status] += 1;
    const mark = c.status === 'PASS' ? 'PASS' : c.status === 'FAIL' ? 'FAIL' : 'SKIP';
    console.log(`[${mark}] ${c.name}`);
    console.log(`       ${c.detail}`);
    if (c.blockedBy !== undefined) console.log(`       blocked by: ${c.blockedBy}`);
  }
  console.log(`\n${report.module}: ${counts.PASS} pass, ${counts.FAIL} fail, ${counts.SKIP} skip`);
  process.exitCode = counts.FAIL > 0 ? 1 : 0;
}
