import { MetaClient } from '../meta/client.ts';
import { loadConfig } from '../config.ts';
import { checkToken, checkAssignedAssets, checkAdAccount, type CheckResult } from './checks.ts';
import { GRAPH_API_VERSION } from '../meta/version.ts';

const ICON: Record<CheckResult['severity'], string> = { PASS: '  ok ', WARN: ' warn', BLOCK: 'BLOCK' };

/**
 * Verifies every prerequisite in docs/SETUP.md against the live API and reports exactly
 * what is missing and who has to fix it. Read-only in every mode.
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
    console.log(title);
    for (const r of results) {
      console.log(`  [${ICON[r.severity]}] ${r.name} — ${r.detail}`);
      if (r.remedy && r.severity !== 'PASS') console.log(`          → ${r.remedy}`);
    }
    console.log('');
    all.push(...results);
  };

  const summarise = (): number => {
    const blocks = all.filter((r) => r.severity === 'BLOCK');
    const warns = all.filter((r) => r.severity === 'WARN');
    console.log('─'.repeat(76));
    if (blocks.length === 0) {
      console.log(
        `Ready. ${all.length - warns.length} checks passed` +
          (warns.length ? `, ${warns.length} warning${warns.length === 1 ? '' : 's'}.` : '.'),
      );
      if (cfg.mode === 'SIMULATE') {
        console.log(
          'Runtime mode is SIMULATE — no Meta writes will be made. Set RUNTIME_MODE=STAGE for real paused objects.',
        );
      }
      return 0;
    }
    console.log(`${blocks.length} blocking issue${blocks.length === 1 ? '' : 's'}:\n`);
    for (const b of blocks) console.log(`  · ${b.name} — ${b.detail}`);
    console.log('\nEach one is a human step in Business Settings. None can be resolved by this system.');
    return 1;
  };

  const token = await checkToken(client, cfg.appId, cfg.systemUserToken);
  section('Token', token.results);
  if (!token.ok) return summarise();

  const assets = await checkAssignedAssets(client);
  section('Asset assignments', assets.results);

  for (const id of assets.adAccountIds) {
    section(`Ad account ${id}`, await checkAdAccount(client, id));
  }

  return summarise();
}
