import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import type { SessionInfo, SessionMessageInfo, SessionCreateInput } from "@opencode/client"
import type { SessionAPI } from "../src/runner.ts"

export async function fixture() {
  await mkdir(".local", { recursive: true })
  const root = await mkdtemp(join(process.cwd(), ".local", "fixture-"))
  const repository = join(root, "repository")
  await mkdir(repository)
  await writeFile(join(repository, "result.txt"), "initial\n")
  await writeFile(join(repository, "AGENTS.md"), "Preserve these mandatory instructions.\n")
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", repository, ...args], { stdio: "pipe" })
  git("init", "-q")
  git("add", ".")
  git("commit", "-qm", "chore: create a synthetic fixture")
  return { root, repository, git }
}

export function owner(directory: string): SessionInfo {
  return { id: "ses_owner", projectID: "project_fixture", agent: "build", model: { providerID: "fixture", id: "model", variant: "selected" },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 }, location: { directory }, permissions: [{ action: "edit", resource: "never-change.txt", effect: "deny" }] }
}

export function fakeAPI(source: SessionInfo, work?: (session: SessionInfo, text: string, signal?: AbortSignal) => Promise<string>) {
  const sessions = new Map<string, SessionInfo>([[source.id, source]])
  const messages = new Map<string, SessionMessageInfo[]>()
  const created: SessionCreateInput[] = []
  const interrupted: string[] = []
  const api: SessionAPI = {
    async create(input) {
      created.push(input!)
      const session: SessionInfo = { ...source, id: `ses_worker_${created.length}`, location: input!.location!,
        metadata: input!.metadata ?? {}, permissions: [...(input!.permissions ?? [])],
        model: input!.model!, agent: input!.agent! }
      sessions.set(session.id, session)
      return session
    },
    async get({ sessionID }) { return sessions.get(sessionID)! },
    async prompt(input, options) {
      const session = sessions.get(input.sessionID)!
      const text = work ? await work(session, input.text, options?.signal) : await syntheticWork(session, input.text)
      session.outcome = "succeeded"
      session.cost = 0.01
      session.tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 0, write: 0 } }
      messages.set(session.id, [{ id: "msg_fixture", type: "assistant", agent: source.agent!, model: source.model!,
        time: { created: 1, completed: 2 }, finish: "stop", content: [{ type: "text", text }] }])
      return { id: "msg_prompt", sessionID: session.id, type: "user", time: { created: 1 }, delivery: "steer", payload: { text: input.text } }
    },
    async wait() {},
    async context({ sessionID }) { return messages.get(sessionID) ?? [] },
    async interrupt({ sessionID }) { interrupted.push(sessionID); return { interrupted: true } as never },
  }
  return { api, sessions, messages, created, interrupted }
}

async function syntheticWork(session: SessionInfo, text: string) {
  if (session.metadata?.harness2Role === "task") {
    await writeFile(join(session.location.directory, "result.txt"), text.includes("Check the exact output marker") ? "correct\n" : "baseline\n")
    return "The requested file is ready."
  }
  const directory = session.location.directory
  const reflecting = await access(join(directory, "context", "adoption.json")).then(() => true, () => false)
  if (reflecting) return "<experience>\ncue: marker repository tasks\nlesson: Check the exact output marker.\nevidence: The probes and final patch contain the exact marker.\nconfidence: local execution contrast\n</experience>"
  const selecting = await access(join(directory, "context", "candidates")).then(() => true, () => false)
  if (selecting) return "```choice\nA\n```\n<why>The file contains the requested marker.</why>"
  const file = join(directory, "context", "harness", "systemprompt.md")
  await writeFile(file, await readFile(file, "utf8") + "\nCheck the exact output marker.\n")
  return "<notes>Added an exact output check.</notes>"
}
