import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";
import type { SecretName } from "./types.ts";
import { AppError, SECRET_NAMES } from "./types.ts";

export const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export function equal(a: string, b: string): boolean {
  return timingSafeEqual(
    Buffer.from(digest(a), "hex"),
    Buffer.from(digest(b), "hex"),
  );
}
export class Vault {
  private readonly key: Buffer;
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    const file = join(store.dir, "master.key");
    const env = process.env["AUTOADS_MASTER_KEY"];
    if (env) {
      this.key = Buffer.from(env, "base64");
      if (this.key.length !== 32)
        throw new AppError(
          "AUTOADS_MASTER_KEY must be 32 bytes encoded as base64.",
        );
    } else {
      if (!existsSync(file))
        writeFileSync(file, randomBytes(32), { mode: 0o600, flag: "wx" });
      this.key = readFileSync(file);
      if (this.key.length !== 32)
        throw new AppError(
          "Invalid encryption key. Restore the original master.key.",
        );
    }
  }
  seal(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }
  open(value: string): string {
    const buf = Buffer.from(value, "base64");
    const dec = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
    dec.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([dec.update(buf.subarray(28)), dec.final()]).toString(
      "utf8",
    );
  }
  set(key: SecretName, value: string): void {
    if (!SECRET_NAMES.includes(key))
      throw new AppError("Unknown connection setting.");
    if (!value.trim()) return;
    this.store.db
      .prepare(
        "INSERT INTO secrets VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, this.seal(value.trim()));
  }
  get(key: SecretName): string {
    const row = this.store.db
      .prepare("SELECT value FROM secrets WHERE key=?")
      .get(key);
    if (row) return this.open(String(row["value"]));
    const env: Record<SecretName, string> = {
      metaAppId: "META_APP_ID",
      metaAppSecret: "META_APP_SECRET",
      metaToken: "META_SYSTEM_USER_TOKEN",
      metaUserToken: "META_USER_ACCESS_TOKEN",
      metaLoginConfigId: "META_LOGIN_CONFIG_ID",
      metaWebhookVerifyToken: "META_WEBHOOK_VERIFY_TOKEN",
      minimaxKey: "MINIMAX_API_KEY",
      glmKey: "ZAI_API_KEY",
      openaiKey: "OPENAI_API_KEY",
      seedanceKey: "SEEDANCE_API_KEY",
      googleServiceAccount: "GOOGLE_SERVICE_ACCOUNT_JSON",
      conversionWebhookToken: "CONVERSION_WEBHOOK_TOKEN",
      leadWebhookSecret: "LEAD_WEBHOOK_SECRET",
    };
    return process.env[env[key]] ?? "";
  }
  status(): Record<string, boolean> {
    return Object.fromEntries(
      SECRET_NAMES.map((key) => [key, Boolean(this.get(key))]),
    );
  }
  delete(key: SecretName): void {
    this.store.db.prepare("DELETE FROM secrets WHERE key=?").run(key);
  }
  pageToken(id: string): string {
    const row = this.store.db.prepare("SELECT value FROM page_tokens WHERE page_id=?").get(id);
    return row ? this.open(String(row["value"])) : "";
  }
  savePageToken(id: string, token: string): void {
    if (!/^\d+$/.test(id) || !token) throw new AppError("Invalid Page authorization.");
    this.store.db.prepare("INSERT INTO page_tokens VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET value=excluded.value").run(id, this.seal(token));
  }
  clearPageTokens(): void {
    this.store.db.prepare("DELETE FROM page_tokens").run();
  }
  redact(message: string): string {
    let result = message;
    for (const key of SECRET_NAMES) {
      const secret = this.get(key);
      if (secret.length > 5) result = result.split(secret).join("[redacted]");
    }
    return result
      .replace(
        /([?&](?:access_token|input_token|appsecret_proof|client_secret|code|key)=)[^&\s]+/gi,
        "$1[redacted]",
      )
      .slice(0, 4000);
  }
}
export function passwordHash(password: string): string {
  if (password.length < 12 || password.length > 256)
    throw new AppError("Use a password between 12 and 256 characters.");
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function passwordMatches(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash || password.length > 256) return false;
  const computed = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return (
    expected.length === computed.length && timingSafeEqual(expected, computed)
  );
}
export function setupToken(store: Store): string {
  const env = process.env["AUTOADS_SETUP_TOKEN"];
  if (env) return env;
  const file = join(store.dir, "setup-token");
  if (!existsSync(file))
    writeFileSync(file, randomBytes(24).toString("base64url"), {
      mode: 0o600,
      flag: "wx",
    });
  return readFileSync(file, "utf8").trim();
}
