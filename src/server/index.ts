import { resolve } from "node:path";
import { createApp } from "../app/server.ts";

const port = Number(process.env["PORT"] ?? 3000),
  host = process.env["HOST"] ?? "127.0.0.1";
const origin = process.env["APP_ORIGIN"];
if (
  process.env["NODE_ENV"] === "production" &&
  (!origin || !origin.startsWith("https://"))
)
  throw new Error("Set APP_ORIGIN to the public HTTPS address in production.");
const app = createApp({
  dataDir: resolve(process.env["DATA_DIR"] ?? "data"),
  uiDir: resolve("ui"),
  ...(origin ? { origin } : {}),
});
app.server.listen(port, host, () =>
  console.log(
    `Spend Control is listening on ${host}:${port}. First-time setup uses the token in DATA_DIR/setup-token.`,
  ),
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
