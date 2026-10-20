#!/usr/bin/env node
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"
import { dirname, join, isAbsolute, resolve } from "node:path"
import { homedir } from "node:os"
import { mkdir, readFile, writeFile, rmdir, unlink, realpath, lstat } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { MemoryStore } from "./state.ts"
import { Controller, type StartInput } from "./controller.ts"
import { checkLocalConnection } from "./client.ts"
import { isOpenCode2 } from "./status.ts"
import { validateOracle, pilotReport, type Oracle } from "./pilot.ts"
import { absoluteInterpreter, within } from "./runtime.ts"

const exec = promisify(execFile)
const command = process.argv[2]
const { values } = parseArgs({ args: process.argv.slice(3), options: {
  python: { type: "string" }, session: { type: "string" }, spec: { type: "string" }, confirm: { type: "boolean" },
} })
const entry = fileURLToPath(new URL("./index.js", import.meta.url))
const packageRoot = dirname(dirname(entry))
const python = absoluteInterpreter(values.python ?? "python3", packageRoot)
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

export function installationSource(entry: string, python: string) {
  return `// Managed by opencode-harness2. Remove this directory to disable the plugin.\nimport plugin from ${JSON.stringify(entry)}\nexport default { ...plugin, setup(ctx) { return plugin.setup({ ...ctx, options: { ...ctx.options, python: ${JSON.stringify(python)} } }) } }\n`
}

if (invokedDirectly) try {
  if (command === "doctor") console.log(JSON.stringify(await checkLocalConnection(), null, 2))
  else if (command === "backend-check") {
    const result = await exec(python, ["-I", "-B", fileURLToPath(new URL("../python/controller.py", import.meta.url)), "--check"], { timeout: 15_000 })
    console.log(result.stdout.trim())
  } else if (command === "install" || command === "uninstall") {
    if (!isAbsolute(entry)) throw new Error("The plugin path must be absolute.")
    const directory = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "plugins", "opencode-harness2")
    const target = join(directory, "index.ts")
    const source = installationSource(entry, python)
    if (command === "install") {
      await exec(python, ["-I", "-B", fileURLToPath(new URL("../python/controller.py", import.meta.url)), "--check"], { timeout: 15_000 })
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if ((await lstat(directory)).isSymbolicLink()) throw new Error("The installation directory must not be a symbolic link.")
      await writeFile(target, source, { flag: "wx", mode: 0o600 })
      console.log("Installed the native plugin. Projects remain disabled until explicit opt-in.")
    } else {
      if (await readFile(target, "utf8") !== source) throw new Error("The installation differs from this package. No file was removed.")
      await unlink(target)
      await rmdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOTEMPTY") throw error })
      console.log("Removed this plugin installation. Private experience remains in the state directory.")
    }
  } else if (command === "pilot") {
    if (!values.confirm || !values.spec || !values.session) throw new Error("A pilot requires --spec, --session, and --confirm. It incurs model usage.")
    const spec = JSON.parse(await readFile(values.spec, "utf8")) as StartInput & { repository: string; oracle: Oracle }
    const oracleSha256 = validateOracle(spec.oracle)
    const endpoint = await Service.discover({ version: isOpenCode2 })
    if (!endpoint) throw new Error("Start OpenCode normally first.")
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers({ url: endpoint.url, ...(endpoint.auth ? { auth: endpoint.auth } : {}) }) })
    const repository = await realpath(spec.repository)
    if (within(repository, await realpath(values.spec))) throw new Error("Keep the independent pilot specification outside the source repository.")
    const root = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode-harness2")
    const controller = new Controller(client.session, new MemoryStore(root), repository, python)
    const owner = await client.session.get({ sessionID: values.session })
    const admitted = await controller.start(owner, spec)
    const stop = () => { void controller.cancel() }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    try {
      await controller.wait()
      const status = await controller.status()
      const evaluation = status.run?.result ? await pilotReport(status.run.result, spec.oracle) : null
      const report = { oracleSha256, ...status, evaluation }
      await writeFile(join(admitted.directory, "pilot.json"), JSON.stringify(report, null, 2), { mode: 0o600 })
      console.log(JSON.stringify(report, null, 2))
    }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop) }
    if ((await controller.status()).run?.status !== "ok") process.exitCode = 1
  } else throw new Error("Use doctor, backend-check, install, uninstall, or pilot.")
} catch (error) {
  // Do not print an HTTP client error object or a service registration with credentials.
  console.error(error instanceof Error ? error.message.slice(0, 2000) : "The command failed.")
  process.exitCode = 1
}
