import crypto from "node:crypto";

// One boot per gateway process. OpenClaw can load the plugin several times in one process
// (plugin registry generations). Every copy must share the boot id: with an id per copy, one
// copy took the other's running tasks for tasks cut off by a restart, posted false
// "cut off by a gateway restart" notes and had them re-dispatched (2026-11-04).
const BOOT_KEY = Symbol.for("token-guard.boot");

function processBoot() {
  if (!globalThis[BOOT_KEY]) {
    globalThis[BOOT_KEY] = {
      id: `pid${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
      startedAt: Math.round(Date.now() - process.uptime() * 1000), // when this process started
    };
  }
  return globalThis[BOOT_KEY];
}

export { processBoot };
