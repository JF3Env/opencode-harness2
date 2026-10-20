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
  assert.equal(fixture.created[0]?.parentID, undefined)
  assert.equal(fixture.created[0]?.location?.directory, "/synthetic/copy")
  assert.equal(fixture.sessions.get("ses_worker_1")?.location.directory, "/synthetic/copy")
  assert.equal(fixture.created[0]?.agent, source.agent)
  assert.equal(workerPermissions("task").some((rule) => rule.effect === "allow"), false)
  assert.deepEqual(fixture.created[0]?.permissions?.[0], source.permissions?.[0])
  assert.equal(fixture.created[0]?.metadata?.harness2Worker, true)
  assert.equal(runner.active.size, 0)
})

test("a worker placed outside its workspace stops before the first prompt", async () => {
  const source = owner("/synthetic/project")
  const fixture = fakeAPI(source, async () => "A complete result.")
  const create = fixture.api.create
  const prompted: string[] = []
  // The host behaviour measured on OpenCode 2.0.32 for a session that does not own its directory.
  fixture.api.create = async (input, options) => {
    const created = await create(input, options)
    const placed = { ...created, location: source.location }
    fixture.sessions.set(created.id, placed)
    return placed
  }
  const prompt = fixture.api.prompt
  fixture.api.prompt = async (...args) => {
    prompted.push(args[0].sessionID)
    return prompt(...args)
  }
  const runner = new V2Runner(fixture.api, source, "run")
  await assert.rejects(runner.execute({ directory: "/synthetic/copy", text: "A task", role: "task", label: "base" }, new AbortController().signal),
    /placed the worker in \/synthetic\/project/)
  assert.deepEqual(prompted, [])
  assert.equal(fixture.interrupted.length, 1)
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
