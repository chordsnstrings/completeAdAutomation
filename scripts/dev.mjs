import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

// Preserve the normal Node server while accepting supervised-preview port flags.
// The explicit, ignored marker is used only by the disposable browser QA fixture.
const args=process.argv.slice(2),port=args.indexOf("--port"),host=args.indexOf("--host");
const qa=args.includes("--qa")||existsSync("test/.browser-qa-enabled");
const child=spawn(process.execPath,qa?["--experimental-strip-types","test/support/browser-server.ts","test/.browser-media"]:["--watch","src/server/index.ts"],{
  stdio:"inherit",env:{...process.env,...(port>=0?{PORT:args[port+1]}:{}),...(host>=0?{HOST:args[host+1]}:{}),...(qa?{SC_ENABLE_QA:"1"}:{})},
});
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>child.kill(signal));
child.on("exit",code=>process.exit(code??1));
