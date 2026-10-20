import assert from "node:assert/strict"
import test from "node:test"
import type { ToolEditor } from "@opencode/plugin/promise/tool"
import plugin, { createStatusTool, registerStatus } from "../src/index.ts"
import { isOpenCode2, PLUGIN_ID } from "../src/status.ts"

test("the default export uses the native version 2 entrypoint", () => {
  assert.equal(plugin.id, PLUGIN_ID)
  assert.equal(plugin.setup, registerStatus)
  assert.equal("server" in plugin, false)
})

test("the status tool reports unfinished features without side effects", async () => {
  const tool = createStatusTool("2.0.32")
  assert.equal(tool.name, "harness2_status")
  assert.equal(tool.input.additionalProperties, false)
  assert.deepEqual(JSON.parse((await tool.execute()).content), {
    pluginId: "jf3env.harness2",
    opencodeVersion: "2.0.32",
    stage: "foundation",
    execution: "not_implemented",
    improvement: "not_implemented",
    memory: "not_implemented",
  })
})

test("setup registers only the status tool", async () => {
  const names: string[] = []
  const unexpected = () => assert.fail("Setup must not change existing tools or other domains.")
  const editor: ToolEditor = {
    list: unexpected,
    get: unexpected,
    namespace: unexpected,
    add(tool) { names.push(tool.name) },
    update: unexpected,
    remove: unexpected,
  }
  await registerStatus({
    app: { version: "2.0.32" },
    tool: {
      async transform(callback) {
        callback(editor)
        return { dispose: async () => {} }
      },
    },
  })
  assert.deepEqual(names, ["harness2_status"])
})

test("unsupported versions fail before tool registration", async () => {
  for (const version of ["1.14.18", "3.0.0", "local", "2.invalid"]) {
    await assert.rejects(registerStatus({
      app: { version },
      tool: { transform: async () => assert.fail("Unsupported versions must not register tools.") },
    }), /requires an OpenCode 2 release/)
  }
})

test("version detection accepts version 2 releases and rejects missing metadata", () => {
  for (const version of ["2.0.32", "2.1.0-beta.1", "2.0.32+build.1"]) assert.equal(isOpenCode2(version), true)
  for (const version of [undefined, null, 2, "", "12.0.32", "2.0.32\nextra"]) assert.equal(isOpenCode2(version), false)
})
