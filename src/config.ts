import { readFileSync, existsSync } from 'node:fs';
import type { RuntimeMode } from './meta/client.ts';

const MODES: readonly RuntimeMode[] = ['SIMULATE', 'VALIDATE', 'STAGE', 'LIVE'];

export interface Config {
  appId: string;
  appSecret: string;
  systemUserToken: string;
  mode: RuntimeMode;
}

/** Minimal .env reader — no dependency, and it never overrides a real environment variable. */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export class ConfigError extends Error {}

export function loadConfig(): Config {
  loadDotEnv();
  const missing: string[] = [];
  const req = (key: string): string => {
    const v = process.env[key];
    if (!v) { missing.push(key); return ''; }
    return v;
  };

  const appId = req('META_APP_ID');
  const appSecret = req('META_APP_SECRET');
  const systemUserToken = req('META_SYSTEM_USER_TOKEN');

  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required configuration: ${missing.join(', ')}\n` +
        `Copy .env.example to .env and fill it in. See docs/SETUP.md for where each value comes from.`,
    );
  }

  const raw = (process.env['RUNTIME_MODE'] ?? 'SIMULATE').toUpperCase();
  if (!MODES.includes(raw as RuntimeMode)) {
    throw new ConfigError(`RUNTIME_MODE must be one of ${MODES.join(' | ')}, got "${raw}"`);
  }

  return { appId, appSecret, systemUserToken, mode: raw as RuntimeMode };
}
