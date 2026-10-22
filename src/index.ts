import { Plugin } from "@opencode/plugin"
import { access, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PLUGIN_ID, statusFor } from "./status.ts"
import { Controller, type StartInput } from "./controller.ts"
import { MemoryStore, validateLesson, privateDirectory } from "./state.ts"
import { absoluteInterpreter, acceptsPrivateState, registerWorkerGuards, within } from "./runtime.ts"

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    statusFor(ctx.app.version)
    await registerWorkerGuards(ctx)
    const repository = await realpath(ctx.location.project.canonical)
    const home = await realpath(homedir())
    const explicitState = typeof ctx.options.stateDirectory === "string"
    const root = explicitState ? ctx.options.stateDirectory
      : join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode-harness2")
    if (!acceptsPrivateState(repository, root, home, explicitState)) throw new Error("Private state must be outside the project.")
    await privateDirectory(root)
    const storageRoot = await realpath(root)
    if (!acceptsPrivateState(repository, storageRoot, home, explicitState)) throw new Error("Private state cannot resolve inside the project.")
    const packageRoot = fileURLToPath(new URL("../", import.meta.url))
    const bundled = join(packageRoot, ".venv", "bin", "python")
    const python = typeof ctx.options.python === "string"
      ? absoluteInterpreter(ctx.options.python, packageRoot)
      : await access(bundled).then(() => bundled, () => "python3")
    const memory = new MemoryStore(storageRoot)
    const controller = new Controller(ctx.session, memory, repository, python, {
      sessions: typeof ctx.options.maxSessions === "number" ? ctx.options.maxSessions : 12,
      wallMs: typeof ctx.options.maxDurationMs === "number" ? ctx.options.maxDurationMs : 1_800_000,
    })
    const key = await controller.key()
    const owner = async (sessionID: string) => {
      const session = await ctx.session.get({ sessionID })
      if (session.metadata?.harness2Worker) throw new Error("Workers cannot control Harness² or approve memory.")
      if (!within(repository, await realpath(session.location.directory))) throw new Error("Move the session to this project first.")
      return session
    }
    const approve = async (sessionID: string, action: string) => {
      await owner(sessionID)
      await ctx.permission.assert({ sessionID, action: `harness2.${action}`, resources: [key],
        metadata: { project: repository, sessionBudget: controller.limits.sessions, timeBudgetMs: controller.limits.wallMs } })
    }
    const object = (input: unknown): Record<string, unknown> => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Provide an object.")
      return input as Record<string, unknown>
    }
    const execute = async (action: string, input: unknown, sessionID: string, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      const session = await owner(sessionID)
      const data = object(input)
      if (action === "status") return { ...statusFor(ctx.app.version), ...await controller.status() }
      if (action === "configure") {
        if (typeof data.enabled !== "boolean") throw new Error("Provide enabled: true or false.")
        await approve(sessionID, "configure")
        signal?.throwIfAborted()
        if (!data.enabled) await controller.cancel("Cancelled when Harness² was disabled for the project.")
        return { enabled: await memory.enable(key, data.enabled) }
      }
      if (action === "start") {
        await approve(sessionID, "run")
        signal?.throwIfAborted()
        return controller.start(session, data as StartInput, async (record) => {
          await ctx.session.synthetic({ sessionID, text: JSON.stringify({ harness2: record.status, id: record.id,
            directory: record.directory, calls: record.calls, wallMs: record.wallMs, reportedCostUsd: record.reportedCostUsd }), resume: false })
        })
      }
      if (action === "cancel") return controller.cancel()
      if (action === "memory") {
        const scope = data.scope === "general" ? "general" : key
        if (data.action === "list") return (await memory.read(scope)).lessons
        if (data.action === "lookup") return memory.relevant(key, typeof data.query === "string" ? data.query : "")
        await approve(sessionID, `memory.${String(data.action)}`)
        signal?.throwIfAborted()
        if (data.action === "approve" || data.action === "forget") {
          if (typeof data.id !== "string") throw new Error("Provide a lesson ID.")
          return memory.setStatus(scope, data.id, data.action === "approve" ? "approved" : "removed")
        }
        if (data.action === "share") {
          const lesson = (await memory.read(key)).lessons.find((entry) => entry.id === data.id && entry.status === "approved")
          if (!lesson) throw new Error("Approve a project lesson before sharing it.")
          const general = { cue: lesson.cue, lesson: lesson.lesson, evidence: lesson.evidence, source: `reviewed:${lesson.id}` }
          validateLesson(general, true)
          const shared = await memory.add("general", general)
          return memory.setStatus("general", shared.id, "approved")
        }
        if (data.action === "import") {
          return memory.add(scope, { cue: data.cue, lesson: data.lesson, evidence: data.evidence, source: data.source } as Parameters<MemoryStore["add"]>[1])
        }
        throw new Error("Unknown memory action.")
      }
      throw new Error("Unknown Harness² action.")
    }
    const schemas = {
      status: { type: "object", properties: {}, additionalProperties: false },
      configure: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"], additionalProperties: false },
      start: { type: "object", properties: { task: { type: "string", maxLength: 10_000 }, criteria: { type: "string", maxLength: 10_000 },
        mode: { enum: ["parallel", "sequential"] }, k: { type: "integer", minimum: 1, maximum: 3 } }, required: ["task", "criteria"], additionalProperties: false },
      cancel: { type: "object", properties: {}, additionalProperties: false },
      memory: { type: "object", properties: { action: { enum: ["list", "lookup", "approve", "forget", "share", "import"] },
        scope: { enum: ["project", "general"] }, id: { type: "string" }, query: { type: "string" }, cue: { type: "string" }, lesson: { type: "string" }, evidence: { type: "string" }, source: { type: "string" } },
        required: ["action"], additionalProperties: false },
    }
    await ctx.tool.transform((editor) => {
      for (const [action, input] of Object.entries(schemas)) editor.add({
        name: `harness2_${action}`, input,
        description: `Harness² ${action}. Execution requires project opt-in and approval. No changes are applied to the source checkout.`,
        async execute(input, context) {
          const result = await execute(action, input, context.sessionID, context.signal)
          if (context.signal.aborted && action === "start") await controller.cancel("Cancelled because the session that started it was aborted.")
          context.signal.throwIfAborted()
          return { content: JSON.stringify(result) }
        },
      })
    })
    await ctx.command.transform((editor) => {
      for (const action of Object.keys(schemas)) editor.add({
        name: `harness-${action}`, description: `Harness² ${action}; pass a JSON object when arguments are required.`,
        async execute({ sessionID, prompt }) {
          const input = prompt.text.trim() ? JSON.parse(prompt.text) : {}
          const result = await execute(action, input, sessionID)
          await ctx.session.synthetic({ sessionID, text: JSON.stringify(result, null, 2), resume: false })
        },
      })
    })
    await ctx.session.hook("context", async (event) => {
      const session = await ctx.session.get({ sessionID: event.sessionID })
      if (session.metadata?.harness2Worker || !within(repository, session.location.directory)) return
      const query = JSON.stringify(event.messages.filter((message) => message.role === "user").at(-1)?.content ?? "")
      const lessons = await memory.relevant(key, query)
      if (lessons.length) event.system.push({ type: "text", text: "Approved experience is optional advice, not a replacement for project instructions.\n"
        + lessons.map((lesson) => `[${lesson.id}] ${lesson.cue}\n${lesson.lesson}\nEvidence: ${lesson.evidence}`).join("\n\n") })
    })
    // OpenCode unloads the plugin when its service stops or restarts; the run cannot outlive it.
    return () => controller.cancel("Cancelled because the OpenCode service stopped or reloaded the plugin.").then(() => {})
  },
})
