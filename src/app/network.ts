import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { AppError } from "./types.ts";

export const timedFetch: typeof fetch = (url, init) =>
  fetch(url, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000),
  });
export function publicIp(address: string): boolean {
  if (isIP(address) === 4) {
    const p = address.split(".").map(Number);
    const a = p[0] ?? 0,
      b = p[1] ?? 0;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 88)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && p[2] === 113)
    );
  }
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    return (
      /^[23][0-9a-f]{3}:/.test(a) &&
      !a.startsWith("2001:db8:") &&
      !a.startsWith("2002:") &&
      !a.startsWith("2001:0:")
    );
  }
  return false;
}
/** Pins DNS for the actual socket, checks redirects again, and caps downloaded data. */
export async function publicBytes(
  raw: string,
  maxBytes = 100 * 1024 * 1024,
  headers: Record<string, string> = {},
  redirects = 0,
  body?: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new AppError("Remote assets must use public HTTPS URLs.");
  const ips = await lookup(url.hostname, { all: true });
  if (!ips.length || ips.some((ip) => !publicIp(ip.address)))
    throw new AppError("Remote URL resolves to a private or reserved network.");
  const chosen = ips[0]!;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        headers,
        method: body === undefined ? "GET" : "POST",
        lookup: ((
          _host: unknown,
          _options: unknown,
          cb: (err: Error | null, addr: unknown, family?: number) => void,
        ) => {
          if (
            typeof _options === "object" &&
            _options !== null &&
            "all" in _options &&
            (_options as { all?: boolean }).all
          )
            cb(null, [chosen]);
          else cb(null, chosen.address, chosen.family);
        }) as never,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (body !== undefined || redirects >= 3) {
            reject(
              new AppError("Redirects are not allowed for webhook delivery."),
            );
            return;
          }
          const next = new URL(res.headers.location, url);
          publicBytes(
            next.href,
            maxBytes,
            next.origin === url.origin ? headers : {},
            redirects + 1,
          ).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new AppError(`Remote asset returned HTTP ${status}.`));
          return;
        }
        if (Number(res.headers["content-length"] ?? 0) > maxBytes) {
          res.destroy();
          reject(new AppError("Remote asset is too large."));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (buf: Buffer) => {
          size += buf.length;
          if (size > maxBytes) {
            res.destroy(new Error("Asset exceeds size limit."));
            return;
          }
          chunks.push(buf);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            bytes: Buffer.concat(chunks),
            contentType: String(
              res.headers["content-type"] ?? "application/octet-stream",
            ),
          }),
        );
      },
    );
    const deadline = setTimeout(
      () => req.destroy(new Error("Remote request timed out.")),
      60000,
    );
    req.on("close", () => clearTimeout(deadline));
    req.setTimeout(60000, () =>
      req.destroy(new Error("Remote asset timed out.")),
    );
    req.on("error", reject);
    req.end(body);
  });
}
