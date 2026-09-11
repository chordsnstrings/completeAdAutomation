import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";

// Verifies the production image with a fresh persistent volume; no external API calls.
const image = process.argv[2] ?? "spend-control:verify";
const name = `spend-control-check-${randomBytes(6).toString("hex")}`;
const origin = "https://spend-control.test";
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 120000 });
let base;
let cookie = "";
let csrf = "";
function containerAddress() {
  const port = docker("port", name, "3000/tcp").trim().split(":").at(-1);
  assert.match(port ?? "", /^\d+$/);
  return `http://127.0.0.1:${port}`;
}
async function request(path, method = "GET", data) {
  return fetch(`${base}${path}`, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data
        ? { "Content-Type": "application/json", "X-CSRF-Token": csrf }
        : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
}
async function ready() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      if ((await request("/healthz")).ok) return;
    } catch {}
    await setTimeout(500);
  }
  throw new Error("Container failed to become healthy.");
}
try {
  docker("volume", "create", name);
  docker(
    "run",
    "-d",
    "--name",
    name,
    "-p",
    "127.0.0.1::3000",
    "-e",
    `APP_ORIGIN=${origin}`,
    "-v",
    `${name}:/app/data`,
    image,
  );
  base = containerAddress();
  await ready();
  assert.equal((await request("/api/bootstrap")).status, 401);
  const page = await request("/");
  assert.equal(page.status, 200);
  assert.ok(
    page.headers.get("content-security-policy")?.includes("default-src 'self'"),
  );
  for (const asset of ["/app.js", "/app.css", "/mark.svg"])
    assert.equal((await request(asset)).status, 200);
  const token = docker("exec", name, "cat", "/app/data/setup-token").trim();
  const password = randomBytes(24).toString("base64url");
  const setup = await request("/api/setup", "POST", { token, password });
  assert.equal(setup.status, 200);
  const setCookie = setup.headers.get("set-cookie");
  assert.ok(setCookie?.includes("Secure"));
  cookie = setCookie.split(";")[0];
  csrf = (await setup.json()).csrf;
  const brand = {
    id: "container-check",
    name: "Container check",
    archetype: "traffic",
    mode: "SIMULATE",
    destination: { url: "https://example.com" },
    countries: ["US"],
    currency: "USD",
    timezone: "UTC",
    proposition: "A private deployment verification.",
    claims: { substantiated: ["Deployment verification only."] },
    spend: {
      dailyBudgetMinor: 10000,
      maxDailyBudgetMinor: 20000,
      targetCpaMinor: 100,
    },
  };
  const created = await request("/api/brands", "POST", brand);
  assert.equal(created.status, 201, await created.text());
  const saved = await request("/api/connections", "POST", {
    secrets: { openaiKey: "container-check-only-not-a-real-key" },
  });
  assert.equal(saved.status, 200);
  docker(
    "exec",
    name,
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=white:s=360x640:r=30:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-vf",
    "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text=Spend Control:fontcolor=black:fontsize=24:x=20:y=20",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    "-shortest",
    "/app/data/render-check.mp4",
  );
  const probe = JSON.parse(
    docker(
      "exec",
      name,
      "ffprobe",
      "-v",
      "error",
      "-show_streams",
      "-of",
      "json",
      "/app/data/render-check.mp4",
    ),
  );
  assert.ok(probe.streams.some((s) => s.codec_name === "h264"));
  assert.ok(probe.streams.some((s) => s.codec_name === "aac"));
  docker("restart", "--time", "30", name);
  // Docker can allocate a different ephemeral host port when the container starts again.
  base = containerAddress();
  await ready();
  const after = await request("/api/bootstrap");
  assert.equal(after.status, 200, "owner session survives a restart");
  const data = await after.json();
  assert.ok(data.brands.some((b) => b.id === brand.id));
  assert.equal(data.connections.openaiKey, true);
  assert.ok(
    !JSON.stringify(data).includes("container-check-only-not-a-real-key"),
  );
  assert.equal(data.runs.length, 0);
  console.log(
    "Production container passed: HTTP, owner setup, secure cookies, encrypted persistence, restart, static assets and FFmpeg.",
  );
} catch (error) {
  process.exitCode = 1;
  console.error(error);
  try {
    console.error(docker("logs", "--tail", "40", name));
  } catch {}
} finally {
  try {
    docker("rm", "-f", name);
  } catch {}
  try {
    docker("volume", "rm", name);
  } catch {}
}
