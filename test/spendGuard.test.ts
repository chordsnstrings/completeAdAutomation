import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaClient, SpendGuardError, parseBigIntSafe, type RuntimeMode } from '../src/meta/client.ts';
import { classify } from '../src/meta/errors.ts';
import { parseRateLimitHeaders, shouldCircuitBreak } from '../src/meta/rateLimit.ts';

const NON_LIVE: RuntimeMode[] = ['SIMULATE', 'VALIDATE', 'STAGE'];

function client(mode: RuntimeMode, fetchImpl?: typeof fetch): MetaClient {
  return new MetaClient({
    appId: 'app',
    appSecret: 'secret',
    accessToken: 'token',
    mode,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

const neverCalled: typeof fetch = () => {
  throw new Error('network must not be touched');
};

test('activation is refused in every mode except LIVE', async () => {
  for (const mode of NON_LIVE) {
    for (const field of ['status', 'configured_status', 'effective_status']) {
      await assert.rejects(
        () => client(mode, neverCalled).post('act_1/campaigns', { [field]: 'ACTIVE' }),
        SpendGuardError,
        `${mode} must refuse ${field}=ACTIVE`,
      );
    }
  }
});

test('lowercase activation is caught too', async () => {
  await assert.rejects(
    () => client('STAGE', neverCalled).post('act_1/campaigns', { status: 'active' }),
    SpendGuardError,
  );
});

test('STAGE permits creating real PAUSED objects', async () => {
  let sent = false;
  const fake: typeof fetch = async () => {
    sent = true;
    return new Response(JSON.stringify({ id: '123' }), { status: 200 });
  };
  const res = await client('STAGE', fake).post<{ id: string }>('act_1/campaigns', {
    name: 'test',
    status: 'PAUSED',
  });
  assert.equal(sent, true, 'STAGE must reach the network — that is what makes it useful');
  assert.equal(res.id, '123');
});

test('SIMULATE records the intent and never touches the network', async () => {
  const intents: string[] = [];
  const c = new MetaClient({
    appId: 'app',
    appSecret: 'secret',
    accessToken: 'token',
    mode: 'SIMULATE',
    fetchImpl: neverCalled,
    onIntent: (i) => intents.push(i.path),
  });
  const res = await c.post<{ __simulated: boolean }>('act_1/campaigns', { status: 'PAUSED' });
  assert.equal(res.__simulated, true);
  assert.deepEqual(intents, ['act_1/campaigns']);
});

test('VALIDATE sends execution_options=validate_only', async () => {
  let body = '';
  const fake: typeof fetch = async (_url, init) => {
    body = String((init as RequestInit).body);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  await client('VALIDATE', fake).post('act_1/campaigns', { status: 'PAUSED' });
  assert.match(body, /execution_options=%5B%22validate_only%22%5D/);
});

test('object ids beyond 2^53 survive parsing', () => {
  const parsed = parseBigIntSafe('{"id":23851234567890123,"n":42}') as Record<string, unknown>;
  assert.equal(parsed['id'], '23851234567890123', 'a mangled id is a write against the wrong object');
  assert.equal(parsed['n'], 42, 'small numbers stay numbers');
});

test('an error body under HTTP 200 is still an error', async () => {
  const fake: typeof fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'nope', code: 190 } }), { status: 200 });
  await assert.rejects(() => client('LIVE', fake).get('me'), /Meta 190 \[AUTH_FAILED\]/);
});

test('error classification routes each code to the right response', () => {
  assert.equal(classify(190), 'AUTH_FAILED');
  assert.equal(classify(80004), 'THROTTLED');
  assert.equal(classify(613, 1487632), 'THROTTLED', 'budget edit cap is throttling, not a bug');
  assert.equal(classify(100, 2859024), 'ACCOUNT_BLOCKED', 'certification needs a human');
  assert.equal(classify(100), 'PERMANENT');
  assert.equal(classify(2), 'AMBIGUOUS', 'a write may have landed — never blind-retry');
  assert.equal(classify(999999), 'PERMANENT', 'unknown codes must not be retried');
});

test('circuit breaker trips on the worst of the three BUC metrics', () => {
  const headers = new Headers({
    'x-business-use-case-usage': JSON.stringify({
      'act_1': [{ type: 'ads_management', call_count: 12, total_cputime: 95, total_time: 20 }],
    }),
  });
  const breaker = shouldCircuitBreak(parseRateLimitHeaders(headers));
  assert.equal(breaker.tripped, true, 'cpu time alone must trip it');
  assert.match(String(breaker.reason), /cpu 95/);
});

test('a cut-off account trips the breaker regardless of percentages', () => {
  const headers = new Headers({
    'x-business-use-case-usage': JSON.stringify({
      'act_1': [{ type: 'ads_management', call_count: 1, estimated_time_to_regain_access: 300000 }],
    }),
  });
  assert.equal(shouldCircuitBreak(parseRateLimitHeaders(headers)).tripped, true);
});
