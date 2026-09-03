import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Brand } from './brand.ts';
import { validateBrand } from './brand.ts';

export interface LoadedBrand {
  brand: Brand;
  file: string;
  problems: string[];
}

/**
 * One YAML file per brand. Files rather than a database because these are decisions a
 * human made and warranted — the claim set especially — so they belong in review and in
 * version control, not in a table an autonomous process can quietly rewrite.
 */
export function loadBrands(dir = 'brands'): LoadedBrand[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && !f.startsWith('.'));
  const loaded: LoadedBrand[] = [];
  const seen = new Map<string, string>();

  for (const file of files.sort()) {
    const path = join(dir, file);
    let brand: Brand;
    try {
      brand = parse(readFileSync(path, 'utf8')) as Brand;
    } catch (e) {
      loaded.push({
        brand: { id: file } as Brand,
        file: path,
        problems: [`unparseable YAML: ${e instanceof Error ? e.message : String(e)}`],
      });
      continue;
    }

    const problems = validateBrand(brand);

    // Brand ids appear in deterministic object names and are the reconciliation key for
    // ambiguous writes, so a collision would let two brands claim each other's objects.
    const prior = seen.get(brand.id);
    if (prior) problems.push(`duplicate brand id "${brand.id}" — also defined in ${prior}`);
    else seen.set(brand.id, path);

    loaded.push({ brand, file: path, problems });
  }
  return loaded;
}
