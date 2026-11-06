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

test("every tool the plugin registers is declared in the manifest (OpenClaw refuses undeclared tools)", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const src = fs.readFileSync(path.join(dir, "index.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "openclaw.plugin.json"), "utf8"));
  const registered = new Set();
  for (const m of src.matchAll(/api\.registerTool\(/g)) {
    const after = src.slice(m.index, m.index + 4000);
    const opt = /\},\s*\{\s*name:\s*"([\w-]+)"\s*\}\s*\)/.exec(after); // registerTool(factory, { name })
    const own = /name:\s*"([\w-]+)"/.exec(after); // registerTool({ name, ... })
    registered.add((opt && opt.index < after.indexOf("api.registerTool(", 1) >>> 0 ? opt : own)[1]);
  }
  assert.ok(registered.has("task_inbox") && registered.has("wake_orchestrator"), [...registered].join(","));
  for (const name of registered) {
    assert.ok(manifest.contracts.tools.includes(name), `${name} missing from contracts.tools`);
    assert.ok(manifest.toolMetadata && manifest.toolMetadata[name], `${name} missing from toolMetadata`);
  }
});
