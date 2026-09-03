import { loadBrands } from './loader.ts';
import { resolveAdConfig } from './brand.ts';
import { unverifiedArchetypes } from '../meta/objectives.ts';

/**
 * Validates every brand file and prints the campaign tuple each one will publish with.
 *
 * Makes the config legible before it spends anything: an operator can see that
 * "example-brand" resolves to OUTCOME_LEADS / ON_AD / LEAD_GENERATION without reading
 * the matrix or waiting for a rejection.
 */
export function reportBrands(dir = 'brands'): number {
  const loaded = loadBrands(dir);

  if (loaded.length === 0) {
    console.log(`\nNo brand files in ${dir}/. Copy brands/example-brand.yaml and edit it.\n`);
    return 1;
  }

  console.log(`\n${loaded.length} brand file${loaded.length === 1 ? '' : 's'} in ${dir}/\n`);
  let bad = 0;

  for (const { brand, file, problems } of loaded) {
    if (problems.length > 0) {
      bad++;
      console.log(`  [BLOCK] ${brand.id ?? file}  (${file})`);
      for (const p of problems) console.log(`          · ${p}`);
      console.log('');
      continue;
    }

    const { spec, dailyBudgetMinor } = resolveAdConfig(brand);
    const flag = spec.confidence === 'inferred' ? '  [UNVERIFIED TUPLE]' : '';
    console.log(`  [  ok ] ${brand.id}  (${file})`);
    console.log(`          ${brand.name} — ${brand.archetype}${flag}`);
    console.log(
      `          ${spec.objective} / ${spec.destinationType ?? 'destination_type omitted'} / ` +
        `${spec.optimizationGoal} / ${spec.billingEvent}`,
    );
    console.log(
      `          page ${brand.pageId} · ${brand.adAccountId} · ${dailyBudgetMinor} minor/day ` +
        `(ceiling ${brand.spend.maxDailyBudgetMinor})`,
    );
    if (!brand.claims.likenessRightsConfirmed) {
      console.log(`          note: likeness rights unconfirmed — no human presenter will be generated`);
    }
    if (spec.confidence === 'inferred') console.log(`          why unverified: ${spec.note}`);
    console.log('');
  }

  const unverified = unverifiedArchetypes().map((s) => s.archetype);
  console.log('─'.repeat(76));
  console.log(
    `Archetypes resting on an unverified tuple: ${unverified.join(', ')}.\n` +
      `Each needs one live create call to settle. The rest are quoted from Meta's own tables.`,
  );

  if (bad > 0) {
    console.log(`\n${bad} brand file${bad === 1 ? '' : 's'} will not publish until fixed.`);
    return 1;
  }
  return 0;
}
