import assert from "node:assert/strict"
import test from "node:test"
import { V2Runner, workerPermissions } from "../src/runner.ts"
import { fakeAPI, owner } from "./fixtures.ts"

test("workers preserve the selection and never add permission allows", async () => {
  const source = owner("/synthetic/project")
  const fixture = fakeAPI(source, async () => "A complete result.")
  const runner = new V2Runner(fixture.api, source, "run-fixture")
  const result = await runner.execute({ directory: "/synthetic/copy", text: "A task", role: "task", label: "base1" }, new AbortController().signal)
  assert.equal(result.text, "A complete result.")
  assert.deepEqual(fixture.created[0]?.model, source.model)
  assert.equal(fixture.created[0]?.parentID, source.id)
  assert.equal(fixture.created[0]?.agent, source.agent)
  assert.equal(workerPermissions("task").some((rule) => rule.effect === "allow"), false)
  assert.deepEqual(fixture.created[0]?.permissions?.[0], source.permissions?.[0])
  assert.equal(fixture.created[0]?.metadata?.harness2Worker, true)
  assert.equal(runner.active.size, 0)
})

test("truncated output is not a completed task", async () => {
  const source = owner("/synthetic/project")
  const fixture = fakeAPI(source, async () => "A result")
  const prompt = fixture.api.prompt
  fixture.api.prompt = async (...args) => {
    const result = await prompt(...args)
    const message = fixture.messages.get(args[0].sessionID)![0]!
    if (message.type === "assistant") message.finish = "length"
    return result
  }
  await assert.rejects(new V2Runner(fixture.api, source, "run").execute({ directory: "/copy", text: "task", role: "task", label: "base" }, new AbortController().signal), /usable final answer/)
  assert.equal(fixture.interrupted.length, 1)
})

test("cancellation interrupts the actual worker instead of only aborting the wait", async () => {
  const source = owner("/synthetic/project")
  const abort = new AbortController()
  let begin!: () => void
  const ready = new Promise<void>((resolve) => { begin = resolve })
  const fixture = fakeAPI(source, async (_session, _text, signal) => {
    begin()
    return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }))
  })
  const runner = new V2Runner(fixture.api, source, "run")
  const pending = runner.execute({ directory: "/copy", text: "task", role: "task", label: "base" }, abort.signal)
  await ready
  abort.abort()
  await assert.rejects(pending)
  assert.ok(fixture.interrupted.includes("ses_worker_1"))
  assert.equal(runner.active.size, 0)
})
