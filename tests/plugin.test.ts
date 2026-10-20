import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { symlink } from "node:fs/promises"
import plugin from "../src/index.ts"
import { isOpenCode2, PLUGIN_ID } from "../src/status.ts"
import { absoluteInterpreter, acceptsPrivateState } from "../src/runtime.ts"
import { fixture, owner } from "./fixtures.ts"
import { context } from "./context.ts"

test("the native plugin registers controls without changing the model or existing tools", async () => {
  const f = await fixture()
  const source = owner(f.repository)
  const h = context(source, join(f.root, "state"))
  const cleanup = await plugin.setup(h.ctx)
  assert.equal(plugin.id, PLUGIN_ID)
  assert.equal("server" in plugin, false)
  assert.deepEqual([...h.tools.keys()].sort(), ["harness2_cancel", "harness2_configure", "harness2_memory", "harness2_start", "harness2_status"])
  const status = await h.invoke("harness2_status", {})
  assert.equal(status.enabled, false)
  assert.equal(status.stage, "experimental")
  const selection = structuredClone(source.model)
  await h.commands.get("harness-status")!.execute({ sessionID: source.id, prompt: { text: "" } })
  assert.equal(h.synthetic[0]?.resume, false)
  assert.deepEqual(source.model, selection)
  assert.equal(h.approvals.length, 0)
  if (typeof cleanup === "function") await cleanup()
})

test("memory injection needs opt-in and explicit lesson approval", async () => {
  const f = await fixture()
  const source = owner(f.repository)
  const h = context(source, join(f.root, "state"))
  await plugin.setup(h.ctx)
  const event = () => ({ sessionID: source.id, system: [], messages: [{ role: "user", content: "marker task" }], options: { selected: "untouched" }, tools: {} })
  assert.deepEqual((await h.hook("session.context", event())).system, [])
  await h.invoke("harness2_configure", { enabled: true })
  const candidate = await h.invoke("harness2_memory", { action: "import", cue: "marker task", lesson: "Check the marker.", evidence: "A fixture confirmed the exact marker.", source: "manual:journal-record" })
  assert.deepEqual((await h.hook("session.context", event())).system, [])
  await h.invoke("harness2_memory", { action: "approve", id: candidate.id })
  const injected = await h.hook("session.context", event())
  assert.equal(injected.system.length, 1)
  assert.deepEqual(injected.options, { selected: "untouched" })
  assert.equal(h.approvals.length, 3)
})

test("worker guards deny arbitrary tools and preserve existing denials", async () => {
  const f = await fixture()
  const source = owner(f.repository)
  source.metadata = { harness2Worker: true, harness2Role: "editor" }
  const h = context(source, join(f.root, "state"))
  await plugin.setup(h.ctx)
  for (const action of ["shell", "execute", "subagent", "a_custom_tool", "harness2.run"]) {
    const event = await h.hook("permission.evaluate", { sessionID: source.id, action, effect: "allow", resources: ["*"] })
    assert.equal(event.effect, "deny", action)
  }
  const originalDeny = await h.hook("permission.evaluate", { sessionID: source.id, action: "read", effect: "deny", resources: ["file"] })
  assert.equal(originalDeny.effect, "deny")
  const outside = await h.hook("permission.evaluate", { sessionID: source.id, action: "edit", effect: "allow", resources: ["MISSION.md"] })
  assert.equal(outside.effect, "deny")
  const writeOutside = await h.hook("permission.evaluate", { sessionID: source.id, action: "write", effect: "allow", resources: ["MISSION.md"] })
  assert.equal(writeOutside.effect, "deny")
  const harness = await h.hook("permission.evaluate", { sessionID: source.id, action: "write", effect: "allow", resources: ["context/harness/systemprompt.md"] })
  assert.equal(harness.effect, "allow")
  const answer = await h.hook("permission.evaluate", { sessionID: source.id, action: "edit", effect: "allow", resources: ["output/answer.md"] })
  assert.equal(answer.effect, "allow")
  const event = await h.hook("session.context", { sessionID: source.id, tools: { read: {}, shell: {}, custom: {}, execute: {} }, system: [], messages: [] })
  assert.deepEqual(Object.keys(event.tools), ["read"])
  await assert.rejects(h.invoke("harness2_configure", { enabled: true }), /Workers cannot control/)
  await assert.rejects(h.hook("tool.execute.before", { sessionID: source.id, tool: "read", input: { path: "../private" } }), /cannot leave/)
  await symlink(f.root, join(f.repository, "external-link"))
  await assert.rejects(h.hook("tool.execute.before", { sessionID: source.id, tool: "read", input: { path: "external-link" } }), /external link/)
  await assert.rejects(h.hook("tool.execute.before", { sessionID: source.id, tool: "patch", input: { patchText: "*** Update File: ../private\n" } }), /cannot leave/)
  await assert.rejects(h.hook("tool.execute.before", { sessionID: source.id, tool: "write", input: { path: "MISSION.md" } }), /only context\/harness/)
})

test("mutating controls ask for approval without relaxing configured denials", async () => {
  const f = await fixture()
  const source = owner(f.repository)
  const h = context(source, join(f.root, "state"))
  await plugin.setup(h.ctx)
  const allow = await h.hook("permission.evaluate", { sessionID: source.id, action: "harness2.run", effect: "allow", resources: ["project"] })
  const deny = await h.hook("permission.evaluate", { sessionID: source.id, action: "harness2.run", effect: "deny", resources: ["project"] })
  assert.equal(allow.effect, "ask")
  assert.equal(deny.effect, "deny")
})

test("private state stays outside a repository and a relative interpreter is package-local", async () => {
  const home = "/Users/example"
  const state = "/Users/example/.local/state/opencode-harness2"
  assert.equal(acceptsPrivateState("/work/repo", "/var/state", home, false), true)
  assert.equal(acceptsPrivateState("/work/repo", "/work/repo/state", home, false), false)
  assert.equal(acceptsPrivateState(home, state, home, false), true)
  assert.equal(acceptsPrivateState(home, "/Users/example/repo/.harness2", home, true), false)
  assert.equal(acceptsPrivateState("/", state, home, false), true)
  assert.equal(acceptsPrivateState("/", "/tmp/state", home, true), false)
  assert.equal(absoluteInterpreter(".venv/bin/python", "/pkg"), "/pkg/.venv/bin/python")
  assert.equal(absoluteInterpreter("/usr/bin/python3", "/pkg"), "/usr/bin/python3")
  assert.equal(absoluteInterpreter("python3", "/pkg"), "python3")
  const f = await fixture()
  const source = owner(f.repository)
  const inside = context(source, join(f.repository, "state"))
  await assert.rejects(async () => plugin.setup(inside.ctx), /Private state must be outside the project/)
})

test("version detection accepts version 2 releases and rejects missing metadata", () => {
  for (const version of ["2.0.32", "2.1.0-beta.1", "2.0.32+build.1"]) assert.equal(isOpenCode2(version), true)
  for (const version of [undefined, null, 2, "", "12.0.32", "2.0.32\nextra"]) assert.equal(isOpenCode2(version), false)
})
