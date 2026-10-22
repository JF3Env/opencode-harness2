import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { Controller } from "../dist/controller.js"
import { MemoryStore } from "../dist/state.js"
import { fixture, fakeAPI, owner } from "./fixtures.ts"

const python = join(process.cwd(), ".venv", "bin", "python")
const task = { task: "Complete the marker repository task.", criteria: "Return the requested exact marker." }

for (const mode of ["parallel", "sequential"] as const) test(`the real upstream ${mode} cycle completes over the synthetic version 2 transport`, async () => {
  const f = await fixture()
  const source = owner(f.repository)
  const fake = fakeAPI(source)
  const memory = new MemoryStore(join(f.root, "state"))
  const controller = new Controller(fake.api, memory, f.repository, python)
  await memory.enable(await controller.key(), true)
  const admitted = await controller.start(source, { ...task, mode })
  assert.equal(admitted.status, "running")
  await controller.wait()
  const state = await controller.status()
  assert.equal(state.run?.status, "ok", JSON.stringify(state.run))
  assert.equal(state.run?.result?.method, "upstream-harness2")
  assert.equal(state.run?.calls, 8)
  assert.equal(fake.created.length, 8)
  assert.ok(JSON.stringify(state.run?.result?.adopted).includes("correct"))
  assert.equal(await readFile(join(f.repository, "result.txt"), "utf8"), "initial\n")
  assert.equal(f.git("status", "--porcelain").toString(), "")
  const lessons = (await memory.read(await controller.key())).lessons
  assert.equal(lessons.length, 1)
  assert.equal(lessons[0]?.status, "candidate")
  assert.equal((await memory.relevant(await controller.key(), "marker")).length, 0)
})

test("a dirty source fails before any worker or model call", async () => {
  const f = await fixture()
  await writeFile(join(f.repository, "result.txt"), "user work\n")
  const source = owner(f.repository)
  const fake = fakeAPI(source)
  const memory = new MemoryStore(join(f.root, "state"))
  const controller = new Controller(fake.api, memory, f.repository, python)
  await memory.enable(await controller.key(), true)
  await controller.start(source, task)
  await controller.wait()
  assert.equal((await controller.status()).run?.status, "failed")
  assert.equal(fake.created.length, 0)
  assert.equal(await readFile(join(f.repository, "result.txt"), "utf8"), "user work\n")
})

test("an insufficient session cap fails before admission", async () => {
  const f = await fixture()
  const source = owner(f.repository)
  const fake = fakeAPI(source)
  const memory = new MemoryStore(join(f.root, "state"))
  const controller = new Controller(fake.api, memory, f.repository, python, { sessions: 2, wallMs: 30_000 })
  await memory.enable(await controller.key(), true)
  await assert.rejects(controller.start(source, task), /at least 8 sessions/)
  assert.equal(fake.created.length, 0)
})

test("invalid editor retries cannot exceed the session cap", async () => {
  const f = await fixture()
  const source = owner(f.repository)
  const fake = fakeAPI(source, async (session) => {
    if (session.metadata?.harness2Role === "editor") await writeFile(join(session.location.directory, "context", "harness", "systemprompt.md"), "x".repeat(40_000))
    return "A synthetic output."
  })
  const memory = new MemoryStore(join(f.root, "state"))
  const controller = new Controller(fake.api, memory, f.repository, python, { sessions: 8, wallMs: 30_000 })
  await memory.enable(await controller.key(), true)
  await controller.start(source, task)
  await controller.wait()
  assert.equal(fake.created.length, 8)
  assert.equal((await controller.status()).run?.status, "cancelled")
})

test("simultaneous starts admit only one run and cancellation stops its worker", async () => {
  const f = await fixture()
  const source = owner(f.repository)
  let begin!: () => void
  const ready = new Promise<void>((resolve) => { begin = resolve })
  const fake = fakeAPI(source, async (_session, _text, signal) => {
    begin()
    return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }))
  })
  const memory = new MemoryStore(join(f.root, "state"))
  const controller = new Controller(fake.api, memory, f.repository, python)
  await memory.enable(await controller.key(), true)
  const admissions = await Promise.allSettled([controller.start(source, task), controller.start(source, task)])
  assert.equal(admissions.filter((entry) => entry.status === "fulfilled").length, 1)
  await ready
  await controller.cancel()
  assert.equal((await controller.status()).run?.status, "cancelled")
  assert.equal((await controller.status()).run?.error, "Cancelled by the user.")
  assert.equal(fake.created.length, 1)
  assert.ok(fake.interrupted.length)
})

test("a cancellation the user did not ask for records its own reason", async () => {
  const f = await fixture()
  const source = owner(f.repository)
  let begin!: () => void
  const ready = new Promise<void>((resolve) => { begin = resolve })
  const fake = fakeAPI(source, async (_session, _text, signal) => {
    begin()
    return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }))
  })
  const memory = new MemoryStore(join(f.root, "state"))
  const controller = new Controller(fake.api, memory, f.repository, python)
  await memory.enable(await controller.key(), true)
  const admitted = await controller.start(source, task)
  await ready
  await controller.cancel("Cancelled because the OpenCode service stopped or reloaded the plugin.")
  const record = JSON.parse(await readFile(join(admitted.directory, "run.json"), "utf8"))
  assert.equal(record.status, "cancelled")
  assert.equal(record.error, "Cancelled because the OpenCode service stopped or reloaded the plugin.")
})

test("approved experience reaches the next upstream improvement without automatic inheritance", async () => {
  const f = await fixture()
  const source = owner(f.repository)
  const fake = fakeAPI(source)
  const memory = new MemoryStore(join(f.root, "state"))
  const controller = new Controller(fake.api, memory, f.repository, python)
  const key = await controller.key()
  await memory.enable(key, true)
  const lesson = await memory.add(key, { cue: "marker repository", lesson: "Check the marker.", evidence: "A prior independent file check.", source: "manual:journal" })
  await memory.setStatus(key, lesson.id, "approved")
  const admitted = await controller.start(source, task)
  await controller.wait()
  assert.equal((await controller.status()).run?.status, "ok")
  const index = await readFile(join(admitted.directory, "method", "repository-oc2-agg1", "task", "context", "inv1", "library", "INDEX.md"), "utf8")
  assert.ok(index.includes(lesson.id))
})

test("scaling to k=2 retains the upstream blind final selection", async () => {
  const f = await fixture()
  const source = owner(f.repository)
  const fake = fakeAPI(source)
  const memory = new MemoryStore(join(f.root, "state"))
  const controller = new Controller(fake.api, memory, f.repository, python, { sessions: 24, wallMs: 30_000 })
  await memory.enable(await controller.key(), true)
  await controller.start(source, { ...task, k: 2 })
  await controller.wait()
  assert.equal((await controller.status()).run?.status, "ok")
  assert.equal(fake.created.length, 16)
})

test("disabled projects and nested workers cannot start a controller", async () => {
  const f = await fixture()
  const source = owner(f.repository)
  const fake = fakeAPI(source)
  const controller = new Controller(fake.api, new MemoryStore(join(f.root, "state")), f.repository, python)
  await assert.rejects(controller.start(source, task), /Enable Harness/)
  await assert.rejects(controller.start({ ...source, metadata: { harness2Worker: true } }, task), /Worker sessions/)
  assert.equal(fake.created.length, 0)
})

test("a run deadline of two hours is accepted and a longer one is refused", async () => {
  const f = await fixture()
  const fake = fakeAPI(owner(f.repository))
  const memory = new MemoryStore(join(f.root, "state"))
  assert.equal(new Controller(fake.api, memory, f.repository, python, { sessions: 12, wallMs: 7_200_000 }).limits.wallMs, 7_200_000)
  assert.throws(() => new Controller(fake.api, memory, f.repository, python, { sessions: 12, wallMs: 7_200_001 }), /Invalid run limits/)
})
