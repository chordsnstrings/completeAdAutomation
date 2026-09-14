import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Collection, Job, Effect, Activity } from "./types.ts";
import { migrateUsage } from "./usage.ts";
import { AppError, nowIso } from "./types.ts";

/** SQLite owns cross-process exclusion and durable job/effect state. */
export class Store {
  readonly db: DatabaseSync;
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, "spend-control.sqlite"));
    chmodSync(join(dir, "spend-control.sqlite"), 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS documents(collection TEXT NOT NULL,id TEXT NOT NULL,brand_id TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(collection,id));
      CREATE INDEX IF NOT EXISTS documents_brand ON documents(collection,brand_id,updated_at);
      CREATE INDEX IF NOT EXISTS documents_revision ON documents(collection,brand_id,json_extract(data,'$.externalId'),json_extract(data,'$.version')) WHERE collection IN ('businessOutcomes','costAdjustments');
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_states(hash TEXT PRIMARY KEY,browser_hash TEXT NOT NULL,expires INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS page_tokens(page_id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deletion_requests(code TEXT PRIMARY KEY,created_at TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS engagement_ai_usage(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL,day TEXT NOT NULL,model TEXT NOT NULL,tokens INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS engagement_ai_daily ON engagement_ai_usage(brand_id,day);
      CREATE TABLE IF NOT EXISTS effects(key TEXT PRIMARY KEY,state TEXT NOT NULL,value TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,entity_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',due INTEGER NOT NULL,lease TEXT NOT NULL DEFAULT '',lease_until INTEGER NOT NULL DEFAULT 0,attempt INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(state,due,lease_until);
      CREATE TABLE IF NOT EXISTS charges(key TEXT PRIMARY KEY,brand_id TEXT NOT NULL,day TEXT NOT NULL,micros INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS charges_daily ON charges(brand_id,day);
      CREATE TABLE IF NOT EXISTS ai_usage(id TEXT PRIMARY KEY,effect_key TEXT NOT NULL,brand_id TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_usage_date ON ai_usage(created_at,id);
      CREATE INDEX IF NOT EXISTS ai_usage_brand ON ai_usage(brand_id,created_at,id);
      CREATE INDEX IF NOT EXISTS ai_usage_effect ON ai_usage(effect_key);
      CREATE TABLE IF NOT EXISTS locks(name TEXT PRIMARY KEY,owner TEXT NOT NULL,until_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_models(id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,secret TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS agent_runs(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_runs_brand ON agent_runs(brand_id,state);
      CREATE TABLE IF NOT EXISTS agent_tasks(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,brand_id TEXT NOT NULL,role TEXT NOT NULL,state TEXT NOT NULL,due INTEGER NOT NULL,lease TEXT NOT NULL DEFAULT '',lease_until INTEGER NOT NULL DEFAULT 0,attempt INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_tasks_ready ON agent_tasks(state,due,lease_until);
      CREATE INDEX IF NOT EXISTS agent_tasks_run ON agent_tasks(run_id,state);
      PRAGMA optimize;`);
    migrateUsage(this);
  }
  close(): void {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  get<T>(collection: Collection, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM documents WHERE collection=? AND id=?")
      .get(collection, id);
    return row ? (JSON.parse(String(row["data"])) as T) : undefined;
  }
  list<T>(collection: Collection, brandId?: string, limit = 10000): T[] {
    const rows =
      brandId === undefined
        ? this.db
            .prepare(
              "SELECT data FROM documents WHERE collection=? ORDER BY updated_at DESC LIMIT ?",
            )
            .all(collection, limit)
        : this.db
            .prepare(
              "SELECT data FROM documents WHERE collection=? AND brand_id=? ORDER BY updated_at DESC LIMIT ?",
            )
            .all(collection, brandId, limit);
    return rows.map((row) => JSON.parse(String(row["data"])) as T);
  }
  count(collection: Collection): number {
    return Number(
      this.db
        .prepare("SELECT COUNT(*) AS n FROM documents WHERE collection=?")
        .get(collection)?.["n"] ?? 0,
    );
  }
  enqueuePendingLeads(brandId: string): void {
    // Recover leads collected before a CRM was configured without resetting retry delays.
    this.db
      .prepare(
        `INSERT INTO jobs(id,kind,entity_id,due)
      SELECT 'lead:' || d.id,'lead',d.id,? FROM documents d
      LEFT JOIN jobs j ON j.id='lead:' || d.id
      WHERE d.collection='leads' AND d.brand_id=? AND json_extract(d.data,'$.delivery')!='delivered'
        AND (j.id IS NULL OR j.state='done') ORDER BY d.updated_at LIMIT 100
      ON CONFLICT(id) DO UPDATE SET state='queued',due=excluded.due,attempt=0,error='' WHERE jobs.state='done'`,
      )
      .run(Date.now(), brandId);
  }
  put<T extends { id: string }>(
    collection: Collection,
    value: T & { brandId?: string },
  ): T {
    if (collection === "runs") {
      const old = this.get<{ status: string }>(collection, value.id);
      if (old?.status === "cancelled")
        Object.assign(value, { status: "cancelled" });
    }
    this.db
      .prepare(
        "INSERT INTO documents(collection,id,brand_id,updated_at,data) VALUES(?,?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET brand_id=excluded.brand_id,updated_at=excluded.updated_at,data=excluded.data",
      )
      .run(
        collection,
        value.id,
        value.brandId ?? (collection === "brands" ? value.id : ""),
        nowIso(),
        JSON.stringify(value),
      );
    return value;
  }
  remove(collection: Collection, id: string): void {
    this.db
      .prepare("DELETE FROM documents WHERE collection=? AND id=?")
      .run(collection, id);
  }
  setting<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return row ? (JSON.parse(String(row["value"])) as T) : fallback;
  }
  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  event(
    brandId: string,
    kind: Activity["kind"],
    title: string,
    detail = "",
  ): void {
    this.put("activity", {
      id: randomUUID(),
      brandId,
      kind,
      title,
      detail,
      createdAt: nowIso(),
    });
  }
  enqueue(
    kind: string,
    entityId: string,
    due = Date.now(),
    force = true,
  ): void {
    const id = `${kind}:${entityId}`;
    this.db
      .prepare(
        `INSERT INTO jobs(id,kind,entity_id,due) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state='queued',due=excluded.due,lease='',lease_until=0,error='',attempt=0 WHERE jobs.state!='running' AND ?=1`,
      )
      .run(id, kind, entityId, due, force ? 1 : 0);
  }
  claim(now = Date.now()): Job | undefined {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM jobs WHERE (state='queued' AND due<=?) OR (state='running' AND lease_until<?) ORDER BY CASE kind WHEN 'pause' THEN 0 WHEN 'monitor' THEN 1 ELSE 2 END,due LIMIT 1`,
        )
        .get(now, now);
      if (!row) return undefined;
      const lease = randomUUID();
      this.db
        .prepare(
          `UPDATE jobs SET state='running',lease=?,lease_until=?,attempt=attempt+1 WHERE id=?`,
        )
        .run(lease, now + 120000, String(row["id"]));
      return {
        id: String(row["id"]),
        kind: String(row["kind"]),
        entityId: String(row["entity_id"]),
        attempt: Number(row["attempt"]) + 1,
        lease,
      };
    });
  }
  heartbeat(job: Job): boolean {
    return (
      this.db
        .prepare(
          `UPDATE jobs SET lease_until=? WHERE id=? AND lease=? AND state='running'`,
        )
        .run(Date.now() + 120000, job.id, job.lease).changes === 1
    );
  }
  finish(job: Job, due?: number, error = ""): void {
    this.db
      .prepare(
        `UPDATE jobs SET state=?,due=?,lease='',lease_until=0,error=?,attempt=CASE WHEN ?='' THEN 0 ELSE attempt END WHERE id=? AND lease=?`,
      )
      .run(
        due === undefined ? "done" : "queued",
        due ?? Date.now(),
        error,
        error,
        job.id,
        job.lease,
      );
  }
  effect(key: string): Effect | undefined {
    const row = this.db.prepare("SELECT * FROM effects WHERE key=?").get(key);
    return row
      ? {
          key,
          state: String(row["state"]) as Effect["state"],
          value: JSON.parse(String(row["value"])),
          updatedAt: String(row["updated_at"]),
        }
      : undefined;
  }
  startEffect(key: string): boolean {
    return (
      this.db
        .prepare(`INSERT INTO effects VALUES(?,'pending','null',?) ON CONFLICT(key) DO UPDATE SET state='pending',value='null',updated_at=excluded.updated_at WHERE effects.state='failed'`)
        .run(key, nowIso()).changes === 1
    );
  }
  finishEffect(key: string, value: unknown): void {
    this.db
      .prepare(
        `UPDATE effects SET state='done',value=?,updated_at=? WHERE key=?`,
      )
      .run(JSON.stringify(value), nowIso(), key);
  }
  failEffect(key: string, message: string): void {
    this.db
      .prepare(
        `UPDATE effects SET state='failed',value=?,updated_at=? WHERE key=?`,
      )
      .run(JSON.stringify(message), nowIso(), key);
  }
  clearFailedEffect(key: string): void {
    this.db
      .prepare(`DELETE FROM effects WHERE key=? AND state='failed'`)
      .run(key);
  }
  reserveCharge(
    key: string,
    brandId: string,
    day: string,
    micros: number,
    limitUsd: number,
  ): void {
    this.transaction(() => this.reserveChargeInTransaction(key, brandId, day, micros, limitUsd));
  }
  /** Call within a transaction that also records the request and acquires its effect. */
  reserveChargeInTransaction(key: string, brandId: string, day: string, micros: number, limitUsd: number): void {
      const prior = this.db.prepare("SELECT day,micros FROM charges WHERE key=?").get(key);
      if (prior && this.effect(key)?.state !== "failed") return;
      // A definitively rejected attempt may be retried on another account day.
      // Rebook its reservation against today's allowance before making that request.
      const used = this.spent(brandId, day) -
        (prior?.["day"] === day ? Number(prior["micros"]) : 0);
      if (
        !Number.isSafeInteger(micros) ||
        micros < 0 ||
        used + micros > Math.floor(limitUsd * 1000000)
      )
        throw new AppError(
          "The daily production allowance is exhausted. The job will wait until tomorrow.",
        );
      this.db
        .prepare("INSERT INTO charges VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET day=excluded.day,micros=excluded.micros")
        .run(key, brandId, day, micros);
  }
  settleCharge(key: string, micros: number): void {
    if (Number.isSafeInteger(micros) && micros >= 0)
      this.db
        .prepare("UPDATE charges SET micros=? WHERE key=?")
        .run(micros, key);
  }
  spent(brandId: string, day: string): number {
    return Number(
      this.db
        .prepare(
          "SELECT COALESCE(SUM(micros),0) AS total FROM charges WHERE brand_id=? AND day=?",
        )
        .get(brandId, day)?.["total"] ?? 0,
    );
  }
  liveSpend(brandId: string, day?: string): number {
    const row = this.db
      .prepare(
        `WITH ranked AS (
      SELECT data,ROW_NUMBER() OVER(PARTITION BY json_extract(data,'$.adId'),json_extract(data,'$.date') ORDER BY json_extract(data,'$.observedAt') DESC) AS rn
      FROM documents WHERE collection='metrics' AND brand_id=? AND json_extract(data,'$.simulation')=0
    ) SELECT COALESCE(SUM(json_extract(data,'$.spendMinor')),0) AS total FROM ranked WHERE rn=1 AND (?='' OR json_extract(data,'$.date')=?)`,
      )
      .get(brandId, day ?? "", day ?? "");
    return Number(row?.["total"] ?? 0);
  }
  lock(name: string, owner: string, ttl = 120000): boolean {
    const now = Date.now();
    return (
      this.db
        .prepare(
          `INSERT INTO locks VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,until_ms=excluded.until_ms WHERE locks.until_ms<? OR locks.owner=?`,
        )
        .run(name, owner, now + ttl, now, owner).changes === 1
    );
  }
  unlock(name: string, owner: string): void {
    this.db
      .prepare("DELETE FROM locks WHERE name=? AND owner=?")
      .run(name, owner);
  }
}
