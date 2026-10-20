import { randomUUID } from "node:crypto"
import { mkdir, realpath, writeFile, readFile, readdir, rename } from "node:fs/promises"
import { join, relative, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import type { SessionInfo } from "@opencode/client"
import { runBridge } from "./bridge.ts"
import { MemoryStore, privateDirectory, projectKey } from "./state.ts"
import { V2Runner, type SessionAPI } from "./runner.ts"

export type StartInput = { task: string; criteria: string; mode?: "parallel" | "sequential"; k?: number }
export type RunRecord = {
  id: string; status: "running" | "ok" | "partial" | "failed" | "cancelled"; created: string;
  directory: string; calls: number; wallMs: number; reportedCostUsd: number;
  usageIncomplete?: boolean;
  tokens: { input: number; output: number; reasoning: number }; result?: Record<string, unknown>; error?: string;
}
type Job = { abort: AbortController; promise: Promise<void>; record: RunRecord }
const jobs = new Map<string, Job>()
const admissions = new Set<string>()

export class Controller {
  readonly api: SessionAPI
  readonly memory: MemoryStore
  readonly repository: string
  readonly python: string
  readonly limits: { sessions: number; wallMs: number }
  private cachedKey?: string
  constructor(
    api: SessionAPI, memory: MemoryStore, repository: string, python: string,
    limits = { sessions: 12, wallMs: 900_000 },
  ) {
    if (!Number.isInteger(limits.sessions) || limits.sessions < 1 || limits.sessions > 64
      || !Number.isInteger(limits.wallMs) || limits.wallMs < 1 || limits.wallMs > 3_600_000) throw new Error("Invalid run limits.")
    this.api = api; this.memory = memory; this.repository = repository; this.python = python; this.limits = limits
  }

  async key() { return this.cachedKey ??= projectKey(await realpath(this.repository)) }

  async start(owner: SessionInfo, input: StartInput, notify?: (record: RunRecord) => Promise<void>) {
    if (owner.metadata?.harness2Worker) throw new Error("Worker sessions cannot start improvement cycles.")
    if (!input.task?.trim() || !input.criteria?.trim() || input.task.length > 10_000 || input.criteria.length > 10_000) throw new Error("Provide a bounded task and completion criteria.")
    if (!["parallel", "sequential", undefined].includes(input.mode) || !Number.isInteger(input.k ?? 1) || (input.k ?? 1) < 1 || (input.k ?? 1) > 3) throw new Error("Use parallel or sequential mode with k between 1 and 3.")
    const minimum = 7 * (input.k ?? 1) + ((input.k ?? 1) === 1 ? 1 : 2)
    if (minimum > this.limits.sessions) throw new Error(`This cycle needs at least ${minimum} sessions, beyond the configured budget.`)
    const repository = await realpath(this.repository)
    const location = relative(repository, await realpath(owner.location.directory))
    if (isAbsolute(location) || location === ".." || location.startsWith("../")) throw new Error("The source session does not belong to this project.")
    if (!owner.model || !owner.agent) throw new Error("Select a model and agent first.")
    const key = await this.key()
    if (!(await this.memory.read(key)).enabled) throw new Error("Enable Harness² for this project before starting a task.")
    if (jobs.get(key)?.record.status === "running" || admissions.has(key)) throw new Error("This project already has an active run.")
    admissions.add(key)
    try { return await this.admit(owner, input, repository, key, notify) }
    finally { admissions.delete(key) }
  }

  private async admit(owner: SessionInfo, input: StartInput, repository: string, key: string, notify?: (record: RunRecord) => Promise<void>) {
    const id = randomUUID()
    const directory = join(this.memory.root, "runs", key, id)
    await privateDirectory(join(this.memory.root, "runs"))
    await privateDirectory(join(this.memory.root, "runs", key))
    await mkdir(directory, { mode: 0o700 })
    const record: RunRecord = { id, directory, status: "running", created: new Date().toISOString(), calls: 0,
      wallMs: 0, reportedCostUsd: 0, tokens: { input: 0, output: 0, reasoning: 0 } }
    const abort = new AbortController()
    const runner = new V2Runner(this.api, owner, id)
    const started = performance.now()
    const persist = async () => {
      record.wallMs = performance.now() - started
      record.reportedCostUsd = [...runner.usage.values()].reduce((sum, info) => sum + info.cost, 0)
      record.tokens = [...runner.usage.values()].reduce((sum, info) => ({ input: sum.input + info.tokens.input,
        output: sum.output + info.tokens.output, reasoning: sum.reasoning + info.tokens.reasoning }), { input: 0, output: 0, reasoning: 0 })
      record.usageIncomplete = runner.usageIncomplete
      const temporary = join(directory, `run-${randomUUID()}.tmp`)
      await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 })
      await rename(temporary, join(directory, "run.json"))
    }
    await persist()
    const experience = await this.memory.relevant(key, input.task)
    const payload = { repository, runRoot: directory, task: input.task, criteria: input.criteria,
      mode: input.mode === "sequential" ? "seq" : "agg", k: input.k ?? 1, experience,
      pluginEntry: fileURLToPath(new URL("./index.js", import.meta.url)),
      modelRef: `${owner.model!.providerID}/${owner.model!.id}`, limits: this.limits }
    await writeFile(join(directory, "input.json"), JSON.stringify(payload, null, 2), { mode: 0o600 })
    const timeout = setTimeout(() => abort.abort(new Error("Run deadline reached.")), this.limits.wallMs)
    timeout.unref()
    const job: Job = { abort, record, promise: Promise.resolve() }
    jobs.set(key, job)
    job.promise = (async () => {
      try {
        const result = await runBridge(this.python, payload, async (request) => {
          abort.signal.throwIfAborted()
          if (record.calls >= this.limits.sessions) {
            abort.abort(new Error("The session budget is exhausted."))
            abort.signal.throwIfAborted()
          }
          record.calls += 1
          await persist()
          const response = await runner.execute(request, abort.signal)
          await persist()
          return response
        }, abort.signal)
        record.result = result
        record.status = result.status === "ok" ? "ok" : "partial"
        const lesson = result.experience as Record<string, unknown> | undefined
        if (lesson && typeof lesson.cue === "string" && typeof lesson.lesson === "string" && typeof lesson.evidence === "string") {
          await this.memory.add(key, { cue: lesson.cue, lesson: lesson.lesson, evidence: lesson.evidence, source: `harness2-run:${id}` }, result.harness as Record<string, string>)
        }
      } catch (error) {
        record.status = abort.signal.aborted ? "cancelled" : "failed"
        const reason = abort.signal.aborted ? abort.signal.reason : error
        record.error = reason instanceof Error ? reason.message.slice(0, 2400) : "Run failed."
      } finally {
        clearTimeout(timeout)
        await runner.interrupt()
        await persist().catch(() => { record.status = "failed"; record.error = "The final run record could not be persisted." })
        await notify?.(record).catch(() => {})
      }
    })()
    // Callers receive an admitted background run, not a fabricated completed result.
    return { id, directory, status: "running", limits: this.limits }
  }

  async cancel() {
    const job = jobs.get(await this.key())
    if (!job || job.record.status !== "running") return { cancelled: false }
    job.abort.abort(new Error("Cancelled by the user."))
    await job.promise
    return { cancelled: true, id: job.record.id }
  }

  async wait() { await jobs.get(await this.key())?.promise }

  async status() {
    const key = await this.key()
    const enabled = (await this.memory.read(key)).enabled
    const live = jobs.get(key)?.record
    if (live) return { enabled, run: structuredClone(live) }
    const directory = join(this.memory.root, "runs", key)
    const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    const records = await Promise.all(entries.filter((name) => /^[0-9a-f-]{36}$/.test(name)).map(async (name) => {
      const report = JSON.parse(await readFile(join(directory, name, "run.json"), "utf8")) as RunRecord
      return report.status === "running" ? { ...report, status: "unknown_after_restart" } : report
    }))
    records.sort((a, b) => b.created.localeCompare(a.created))
    return { enabled, run: records[0] ?? null }
  }
}
