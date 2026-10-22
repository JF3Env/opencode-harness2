import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const endpoint = await Service.discover({ version: (version) => /^2\./.test(version) })
if (!endpoint) throw new Error("Start OpenCode normally before this explicit, read-only service diagnostic.")
const temporary = process.env.OPENCODE_TEST_TMPDIR ?? join(tmpdir(), "opencode")
await mkdir(temporary, { recursive: true, mode: 0o700 })
const root = await mkdtemp(join(temporary, "harness2-live-"))
let directory = join(root, "project")
await mkdir(join(directory, ".opencode"), { recursive: true })
execFileSync("git", ["-c", "core.hooksPath=/dev/null", "init", "-q", directory])
execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Harness2 Diagnostic", "-c", "user.email=diagnostic@example.invalid",
  "-C", directory, "commit", "--allow-empty", "-qm", `chore: initialize diagnostic ${root}`])
directory = await realpath(directory)
const project = fileURLToPath(new URL("../", import.meta.url))
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url))
const python = join(project, ".venv", "bin", "python")
const stateDirectory = join(root, "state")
const shim = join(directory, ".opencode", "plugins", "opencode-harness2")
await mkdir(shim, { recursive: true })
// OpenCode 2.0.32 loads a discovered plugin file. A local path in the plugins array is visible in config and is not instantiated.
await writeFile(join(shim, "index.ts"), `import plugin from ${JSON.stringify(entry)}\nexport default { ...plugin, setup(ctx) { return plugin.setup({ ...ctx, options: { ...ctx.options, python: ${JSON.stringify(python)}, stateDirectory: ${JSON.stringify(stateDirectory)} } }) } }\n`)
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers({ url: endpoint.url, ...(endpoint.auth ? { auth: endpoint.auth } : {}) }) })
const signal = AbortSignal.timeout(30_000)
const location = await client.location.get({ location: { directory } }, { signal })
const diagnostic = await client.session.create({ location: { directory }, title: "Harness² activation diagnostic", metadata: { harness2Diagnostic: true } }, { signal })
let plugins = await client.plugin.list({ location: { directory } }, { signal })
const deadline = Date.now() + 15_000
let plugin = plugins.data.find((entry) => entry.id === "jf3env.harness2")
while (plugin?.state.status !== "active" && Date.now() < deadline) {
  await delay(250)
  plugins = await client.plugin.list({ location: { directory } }, { signal })
  plugin = plugins.data.find((entry) => entry.id === "jf3env.harness2")
}
await client.session.remove({ sessionID: diagnostic.id }, { signal })
if (plugin?.state.status !== "active") {
  await mkdir(".local", { recursive: true })
  await writeFile(".local/native-plugin-state.json", JSON.stringify(plugins.data.map((entry) => ({ id: entry.id, state: entry.state })), null, 2), { mode: 0o600 })
  await writeFile(".local/native-plugin-location.json", JSON.stringify({ requested: directory, location, listedLocation: plugins.location, sessionLocation: diagnostic.location }, null, 2), { mode: 0o600 })
  const config = await client.config.get({ location: { directory } }, { signal })
  await writeFile(".local/native-plugin-config.json", JSON.stringify(config.map((entry) => ({ type: entry.type, path: entry.path, plugins: entry.info?.plugins, keys: Object.keys(entry) })), null, 2), { mode: 0o600 })
  throw new Error("The native plugin did not activate. Inspect .local/native-plugin-state.json locally.")
}
console.log(JSON.stringify({ pluginId: plugin.id, state: plugin.state.status, modelAccess: "not_exercised", globalConfiguration: "unchanged" }))
