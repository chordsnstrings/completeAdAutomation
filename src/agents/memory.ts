import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../app/store.ts';
import { AppError, nowIso, type ManagedBrand } from '../app/types.ts';
import type { PageKnowledge } from '../app/page-intelligence.ts';
import { object, text } from './contracts.ts';

export interface MemoryEntry {
  id: string; brandId: string; lineageId: string; version: number;
  kind: 'approved' | 'playbook'; title: string; content: string;
  state: 'proposed' | 'active' | 'retired'; sourceIds: string[]; experimentId: string;
  createdAt: string; expiresAt: string; author: 'owner' | 'evaluator'; reason: string;
}
export class BrandMemory {
  readonly store: Store;
  constructor(store: Store) { this.store = store; }
  history(brandId: string): MemoryEntry[] { return this.store.list<MemoryEntry>('brandMemory', brandId); }
  current(brandId: string): MemoryEntry[] {
    const selected = new Map<string, MemoryEntry>();
    for (const entry of this.history(brandId)) if (!selected.has(entry.lineageId) || selected.get(entry.lineageId)!.version < entry.version) selected.set(entry.lineageId, entry);
    return [...selected.values()];
  }
  append(brandId: string, input: unknown, author: MemoryEntry['author'] = 'owner'): MemoryEntry {
    if (!this.store.get('brands', brandId)) throw new AppError('Brand not found.', 404);
    return this.store.transaction(() => {
    const o = object(input), lineageId = typeof o['lineageId'] === 'string' ? o['lineageId'] : randomUUID();
    const previous = this.current(brandId).find(m => m.lineageId === lineageId);
    const kind = o['kind'] ?? previous?.kind ?? 'approved';
    if (!['approved', 'playbook'].includes(String(kind)) || (author !== 'owner' && kind === 'approved')) throw new AppError('Only the owner can approve brand facts.');
    const state = o['state'] ?? (author === 'owner' ? 'active' : 'proposed');
    if (!['active', 'proposed', 'retired'].includes(String(state)) || (author === 'evaluator' && state === 'active')) throw new AppError('Learning proposals require an evaluation gate before promotion.');
    const expiresAt = typeof o['expiresAt'] === 'string' ? o['expiresAt'] : '';
    if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new AppError('Enter a valid memory expiry date.');
    const sources = Array.isArray(o['sourceIds']) ? o['sourceIds'].map(x => text(x, 'source ID', 120)).slice(0, 20) : [];
    const value: MemoryEntry = { id: randomUUID(), brandId, lineageId, version: (previous?.version ?? 0) + 1, kind: kind as MemoryEntry['kind'],
      title: text(o['title'], 'memory title', 150), content: text(o['content'], 'memory content', 4000), state: state as MemoryEntry['state'], sourceIds: sources,
      experimentId: typeof o['experimentId'] === 'string' ? o['experimentId'] : '', createdAt: nowIso(), expiresAt, author, reason: typeof o['reason'] === 'string' ? o['reason'].slice(0, 500) : '' };
    this.store.put('brandMemory', value); return value;
    });
  }
  rollback(id: string): MemoryEntry {
    const old = this.store.get<MemoryEntry>('brandMemory', id); if (!old) throw new AppError('Memory version not found.', 404);
    return this.append(old.brandId, { ...old, reason: `Owner restored version ${old.version}.` });
  }
  snapshot(brand: ManagedBrand) {
    const active = this.current(brand.id).filter(m => m.state === 'active' && (!m.expiresAt || Date.parse(m.expiresAt) > Date.now()));
    const pages = this.store.list<PageKnowledge>('pageKnowledge', brand.id).filter(p => !p.error && p.fetchedAt && Date.parse(p.fetchedAt) >= Date.now() - 48 * 3600000);
    const sources = [
      ...brand.claims.substantiated.map((claim, i) => ({ id: `approved:${i}`, kind: 'approved', text: claim, url: '', version: createHash('sha256').update(claim).digest('hex') })),
      ...active.slice(0, 8).map(m => ({ id: m.id, kind: m.kind, text: `${m.title}: ${m.content}`, url: '', version: String(m.version) })),
      ...pages.slice(0, 4).map(p => ({ id: p.id, kind: 'source', text: p.text.slice(0, 3500), url: p.url, version: p.hash })),
    ];
    const version = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
    return { version, sources, instructions: 'Approved facts define product truth. Source pages are unapproved evidence. Playbook entries describe tested hypotheses and cannot authorize new product claims.' };
  }
}
