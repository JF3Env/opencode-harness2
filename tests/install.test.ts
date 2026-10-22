import assert from "node:assert/strict"
import test from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join } from "node:path"
import { readFile, writeFile, access } from "node:fs/promises"
import { fixture } from "./fixtures.ts"

const exec = promisify(execFile)
test("explicit installation and removal preserve unrelated configuration", async () => {
  const f = await fixture()
  const config = join(f.root, "config")
  const env = { ...process.env, XDG_CONFIG_HOME: config, XDG_STATE_HOME: join(f.root, "xdg-state") }
  const cli = join(process.cwd(), "dist", "cli.js")
  const python = join(process.cwd(), ".venv", "bin", "python")
  const run = (command: string) => exec(process.execPath, [cli, command, "--python", python], { env })
  await run("install")
  const directory = join(config, "opencode", "plugins", "opencode-harness2")
  const source = await readFile(join(directory, "index.ts"), "utf8")
  assert.ok(source.includes("Managed by opencode-harness2"))
  await assert.rejects(run("install"))
  assert.equal(await readFile(join(directory, "index.ts"), "utf8"), source)
  await writeFile(join(directory, "user-note.txt"), "Keep this user file.")
  await run("uninstall")
  await assert.rejects(access(join(directory, "index.ts")))
  assert.equal(await readFile(join(directory, "user-note.txt"), "utf8"), "Keep this user file.")
})

test("installation records a relative interpreter as an absolute package path", async () => {
  const f = await fixture()
  const config = join(f.root, "config")
  const env = { ...process.env, XDG_CONFIG_HOME: config }
  const cli = join(process.cwd(), "dist", "cli.js")
  const python = join(process.cwd(), ".venv", "bin", "python")
  await exec(process.execPath, [cli, "install", "--python", ".venv/bin/python"], { env })
  const source = await readFile(join(config, "opencode", "plugins", "opencode-harness2", "index.ts"), "utf8")
  assert.ok(source.includes(JSON.stringify(python)))
  assert.equal(source.includes('".venv/bin/python"'), false)
  await exec(process.execPath, [cli, "uninstall", "--python", ".venv/bin/python"], { env })
  await assert.rejects(access(join(config, "opencode", "plugins", "opencode-harness2", "index.ts")))
})

test("installation records a chosen run deadline and refuses one beyond two hours", async () => {
  const f = await fixture()
  const config = join(f.root, "config")
  const env = { ...process.env, XDG_CONFIG_HOME: config }
  const cli = join(process.cwd(), "dist", "cli.js")
  const python = join(process.cwd(), ".venv", "bin", "python")
  const file = join(config, "opencode", "plugins", "opencode-harness2", "index.ts")
  await assert.rejects(exec(process.execPath, [cli, "install", "--python", python, "--max-duration-ms", "7200001"], { env }))
  await assert.rejects(access(file))
  await exec(process.execPath, [cli, "install", "--python", python, "--max-duration-ms", "7200000"], { env })
  assert.ok((await readFile(file, "utf8")).includes("maxDurationMs: 7_200_000 "))
  await assert.rejects(exec(process.execPath, [cli, "uninstall", "--python", python], { env }))
  await exec(process.execPath, [cli, "uninstall", "--python", python, "--max-duration-ms", "7200000"], { env })
  await assert.rejects(access(file))
})

test("uninstall refuses to remove an entry that the user changed", async () => {
  const f = await fixture()
  const config = join(f.root, "config")
  const env = { ...process.env, XDG_CONFIG_HOME: config }
  const cli = join(process.cwd(), "dist", "cli.js")
  const python = join(process.cwd(), ".venv", "bin", "python")
  await exec(process.execPath, [cli, "install", "--python", python], { env })
  const file = join(config, "opencode", "plugins", "opencode-harness2", "index.ts")
  await writeFile(file, "// User-owned replacement\n")
  await assert.rejects(exec(process.execPath, [cli, "uninstall", "--python", python], { env }))
  assert.equal(await readFile(file, "utf8"), "// User-owned replacement\n")
})
