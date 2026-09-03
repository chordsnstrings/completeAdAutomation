import { MetaClient } from '../meta/client.ts';
import { loadConfig } from '../config.ts';
import { checkToken, checkAdAccount, checkPages, type CheckResult } from './checks.ts';
import { GRAPH_API_VERSION } from '../meta/version.ts';

const ICON: Record<CheckResult['severity'], string> = { PASS: '  ok ', WARN: ' warn', BLOCK: 'BLOCK' };

/**
 * Verifies every prerequisite in docs/SETUP.md against the live API and reports exactly
 * what is missing. Read-only: it makes no writes in any mode.
 *
 * Exit code 1 if anything is BLOCK, so it can gate a deploy.
 */
export async function runPreflight(): Promise<number> {
  const cfg = loadConfig();
  const client = new MetaClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    accessToken: cfg.systemUserToken,
    mode: cfg.mode,
  });

  console.log(`\nPreflight — Graph API ${GRAPH_API_VERSION}, runtime mode ${cfg.mode}\n`);

  const all: CheckResult[] = [];
  const section = (title: string, results: CheckResult[]): void => {
    console.log(`${title}`);
    for (const r of results) {
      console.log(`  [${ICON[r.severity]}] ${r.name} — ${r.detail}`);
      if (r.remedy && r.severity !== 'PASS') console.log(`          → ${r.remedy}`);
    }
    console.log('');
    all.push(...results);
  };

  const token = await checkToken(client, cfg.appId);
  section('Token', token.results);

  if (token.results.some((r) => r.severity === 'BLOCK')) {
    console.log('Token is unusable; skipping the remaining checks.\n');
    return 1;
  }

  section('Pages', await checkPages(client, cfg.businessId));

  const accounts = token.grantedAdAccounts;
  if (accounts.length === 0) {
    section('Ad accounts', [
      {
        name: 'Ad accounts',
        severity: 'BLOCK',
        detail: 'none granted to this token',
        remedy: 'Assign at least one ad account to the system user with "Manage campaigns".',
      },
    ]);
  } else {
    for (const id of accounts) {
      section(`Ad account ${id}`, await checkAdAccount(client, id));
    }
  }

  const blocks = all.filter((r) => r.severity === 'BLOCK');
  const warns = all.filter((r) => r.severity === 'WARN');

  console.log('─'.repeat(72));
  if (blocks.length === 0) {
    console.log(
      `Ready. ${all.length - warns.length} checks passed` +
        (warns.length ? `, ${warns.length} warning${warns.length === 1 ? '' : 's'}.` : '.'),
    );
    if (cfg.mode === 'SIMULATE') {
      console.log('Runtime mode is SIMULATE — no Meta writes will be made. Set RUNTIME_MODE=STAGE to create real paused objects.');
    }
    return 0;
  }

  console.log(`${blocks.length} blocking issue${blocks.length === 1 ? '' : 's'}:`);
  for (const b of blocks) console.log(`  · ${b.name} — ${b.detail}`);
  console.log('\nEach one is a human step. None can be resolved by this system.');
  return 1;
}
