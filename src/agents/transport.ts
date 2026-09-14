import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { publicIp } from '../app/network.ts';
import { AppError } from '../app/types.ts';
import { modelEndpoint } from './registry.ts';

/** Credential-bearing model requests pin a public address and never follow redirects. */
export const modelFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input)); modelEndpoint(url.href);
  const ips = await lookup(url.hostname, { all: true });
  if (!ips.length || ips.some(ip => !publicIp(ip.address))) throw new AppError('Model endpoint resolves to a private or reserved network.');
  const chosen = ips[0]!;
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: init?.method ?? 'POST', headers: Object.fromEntries(new Headers(init?.headers)),
      lookup: ((_host: unknown, options: { all?: boolean }, cb: (e: Error | null, address: unknown, family?: number) => void) => options?.all ? cb(null, [chosen]) : cb(null, chosen.address, chosen.family)) as never,
    }, res => {
      const status = res.statusCode ?? 502;
      if (status >= 300 && status < 400) { res.resume(); reject(new AppError('Model endpoint redirects are not allowed.')); return; }
      const chunks: Buffer[] = []; let length = 0;
      res.on('data', (b: Buffer) => { length += b.length; if (length > 12 * 1024 * 1024) res.destroy(new Error('Model response exceeds the size limit.')); else chunks.push(b); });
      res.on('error', reject);
      res.on('end', () => { const headers = new Headers(); for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(',') : String(v));
        resolve(new Response(new Uint8Array(Buffer.concat(chunks)), { status, headers })); });
    });
    const abort = () => req.destroy(new Error('Model request interrupted; its outcome needs reconciliation.'));
    if (init?.signal?.aborted) { abort(); reject(new Error('Request cancelled.')); return; }
    init?.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 120000);
    req.on('close', () => { clearTimeout(timeout); init?.signal?.removeEventListener('abort', abort); });
    req.on('error', reject); req.end(init?.body === undefined ? undefined : String(init.body));
  });
};
