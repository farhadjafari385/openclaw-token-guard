import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// index.js needs the OpenClaw SDK, so the other tests never load it. A misnamed
// import there would only fail inside the gateway; check every local named import here.
test("every named import from a local module exists in that module", async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const broken = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/([\w.-]+\.js)"/g)) {
      const mod = await import(path.join(dir, m[2]));
      for (const name of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        if (!(name in mod)) broken.push(`${file}: ${name} from ${m[2]}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});
