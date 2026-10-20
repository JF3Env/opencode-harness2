import type { OpenCodeClient, SessionInfo, PermissionRule, SessionMessageInfo } from "@opencode/client"

export type SessionAPI = Pick<OpenCodeClient["session"], "create" | "get" | "prompt" | "wait" | "context" | "interrupt">
export type WorkerRequest = {
  directory: string
  text: string
  role: "task" | "editor"
  label: string
}

export function workerPermissions(role: WorkerRequest["role"]): PermissionRule[] {
  const rules: PermissionRule[] = [
    ...["shell", "execute", "subagent", "webfetch", "websearch", "question"].map((action) => ({ action, resource: "*", effect: "deny" as const })),
  ]
  for (const action of ["edit", "write", "patch"]) {
    for (const resource of ["AGENTS.md", "*/AGENTS.md", "opencode.json*", "*/opencode.json*", ".opencode/*", "*/.opencode/*", ".git*", "*/.git*", "*.env", "*.env.*", "*.pem", "*.key"]) {
      rules.push({ action, resource, effect: "deny" })
    }
  }
  rules.push({ action: "external_directory", resource: "*", effect: "deny" })
  return rules
}

export function renderTrajectory(messages: SessionMessageInfo[]): string {
  return messages.filter((message) => message.type === "assistant").map((message) => {
    return message.content.map((part) => part.type === "text"
      ? `[OBSERVATION] ${part.text}`
      : part.type === "tool" ? `[ACTION] ${JSON.stringify(part)}` : "").filter(Boolean).join("\n")
  }).join("\n")
}

export class V2Runner {
  readonly active = new Set<string>()
  readonly usage = new Map<string, SessionInfo>()
  usageIncomplete = false
  readonly api: SessionAPI
  readonly owner: SessionInfo
  readonly runID: string
  constructor(api: SessionAPI, owner: SessionInfo, runID: string) { this.api = api; this.owner = owner; this.runID = runID }

  async execute(request: WorkerRequest, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!this.owner.model || !this.owner.agent) throw new Error("Select a model and an agent in the source session first.")
    const started = performance.now()
    // The worker copies the user's session selection. It does not define an agent-specific model or request override.
    const worker = await this.api.create({
      parentID: this.owner.id,
      model: this.owner.model,
      agent: this.owner.agent,
      title: `Harness² ${request.label}`,
      location: { directory: request.directory },
      metadata: { harness2Worker: true, harness2Run: this.runID, harness2Role: request.role },
      permissions: [...(this.owner.permissions ?? []), ...workerPermissions(request.role)],
    }, { signal })
    this.active.add(worker.id)
    const stop = () => { void this.api.interrupt({ sessionID: worker.id, resume: false }, { signal: AbortSignal.timeout(5000) }).catch(() => {}) }
    signal.addEventListener("abort", stop, { once: true })
    try {
      signal.throwIfAborted()
      const selected = await this.api.get({ sessionID: worker.id }, { signal })
      if (selected.model?.id !== this.owner.model.id || selected.model?.providerID !== this.owner.model.providerID
        || selected.model?.variant !== this.owner.model.variant || selected.agent !== this.owner.agent) {
        throw new Error("The worker did not retain the source session selection.")
      }
      await this.api.prompt({ sessionID: worker.id, text: request.text }, { signal })
      await this.api.wait({ sessionID: worker.id }, { signal })
      const info = await this.api.get({ sessionID: worker.id }, { signal })
      this.usage.set(worker.id, info)
      const messages = await this.api.context({ sessionID: worker.id }, { signal })
      const assistants = messages.filter((message) => message.type === "assistant")
      const last = assistants.at(-1)
      const text = last?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? ""
      if (info.outcome !== "succeeded" || !last || last.error || last.finish !== "stop" || !text.trim()) {
        throw new Error("The worker did not complete with a usable final answer.")
      }
      return { text, trajectory: renderTrajectory(messages), sessionID: worker.id, tokens: info.tokens,
        reportedCostUsd: info.cost, wallMs: performance.now() - started }
    } catch (error) {
      await this.api.interrupt({ sessionID: worker.id, resume: false }, { signal: AbortSignal.timeout(5000) }).catch(() => {})
      try { this.usage.set(worker.id, await this.api.get({ sessionID: worker.id }, { signal: AbortSignal.timeout(5000) })) }
      catch { this.usageIncomplete = true }
      throw error
    } finally {
      signal.removeEventListener("abort", stop)
      this.active.delete(worker.id)
    }
  }

  async interrupt() {
    await Promise.allSettled([...this.active].map((sessionID) => this.api.interrupt({ sessionID, resume: false }, { signal: AbortSignal.timeout(5000) })))
  }
}
