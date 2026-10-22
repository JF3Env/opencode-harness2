import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"

mkdirSync(".local", { recursive: true })
const directory = mkdtempSync(join(process.cwd(), ".local", "package-"))
const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { encoding: "utf8" }))[0]
assert.ok(packed.files.some((file) => file.path === "python/controller.py"))
assert.ok(packed.files.some((file) => file.path === "dist/index.js"))
assert.equal(packed.files.some((file) => /(?:^|\/)(?:\.env|\.local|node_modules|\.venv)(?:\/|$)/.test(file.path)), false)
const consumer = join(directory, "consumer")
mkdirSync(consumer)
writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }))
execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(directory, packed.filename)], { cwd: consumer, stdio: "inherit" })
execFileSync(process.execPath, ["--input-type=module", "-e", `
  import assert from 'node:assert/strict';
  import plugin from 'opencode-harness2';
  import { checkLocalConnection } from 'opencode-harness2/client';
  assert.equal(plugin.id, 'jf3env.harness2');
  assert.equal(typeof plugin.setup, 'function');
  assert.equal(typeof checkLocalConnection, 'function');
`], { cwd: consumer, stdio: "inherit" })
assert.throws(() => execFileSync(process.execPath, ["node_modules/opencode-harness2/dist/cli.js"], { cwd: consumer, stdio: "pipe" }),
  (error) => error.status === 1 && error.stderr.toString().includes("Use doctor"))
console.log("PACKAGE_SMOKE=PASS")
