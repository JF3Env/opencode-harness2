import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { lstat, symlink, writeFile } from "node:fs/promises"
import { MemoryStore, projectKey, validateLesson } from "../src/state.ts"
import { fixture } from "./fixtures.ts"

const lesson = { cue: "marker task", lesson: "Check the exact marker.", evidence: "An independent fixture checked the output.", source: "manual:fixture" }

test("memory needs opt-in and approval, survives restart, and stays project-scoped", async () => {
  const { root } = await fixture()
  const store = new MemoryStore(join(root, "memory"))
  const key = projectKey("project-one")
  const candidate = await store.add(key, lesson)
  assert.equal((await store.relevant(key, "marker")).length, 0)
  await store.enable(key, true)
  assert.equal((await store.relevant(key, "marker")).length, 0)
  await store.setStatus(key, candidate.id, "approved")
  const restarted = new MemoryStore(store.root)
  assert.equal((await restarted.relevant(key, "marker"))[0]?.id, candidate.id)
  assert.equal((await restarted.relevant(projectKey("project-two"), "marker")).length, 0)
  assert.equal((await lstat(join(store.root, `${key}.json`))).mode & 0o077, 0)
  await store.setStatus(key, candidate.id, "removed")
  assert.equal((await store.relevant(key, "marker")).length, 0)
})

test("duplicates are idempotent and a busy writer cannot overwrite state", async () => {
  const { root } = await fixture()
  const store = new MemoryStore(join(root, "memory"))
  const key = projectKey("one")
  const first = await store.add(key, lesson)
  const second = await store.add(key, lesson)
  assert.equal(first.id, second.id)
  assert.equal((await store.read(key)).lessons.length, 1)
  const { mkdir } = await import("node:fs/promises")
  await mkdir(join(store.root, `${key}.json.lock`))
  await assert.rejects(store.enable(key, true), /busy or locked/)
  assert.equal((await store.read(key)).enabled, false)
})

test("credential-like strings and private general lessons fail validation", () => {
  assert.throws(() => validateLesson({ ...lesson, lesson: "password=synthetic-long-password" }), /credentials/)
  assert.throws(() => validateLesson({ ...lesson, source: "https://private.example.invalid" }, true), /General lessons/)
  assert.doesNotThrow(() => validateLesson(lesson, true))
})

test("state cannot follow a symbolic link to a foreign file", async () => {
  const { root } = await fixture()
  const store = new MemoryStore(join(root, "memory"))
  const key = projectKey("one")
  await store.read(key)
  const target = join(root, "foreign.json")
  await writeFile(target, "{}", { mode: 0o600 })
  await symlink(target, join(store.root, `${key}.json`))
  await assert.rejects(store.read(key), /Unsafe state file/)
})
