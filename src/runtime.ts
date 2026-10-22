import type { Plugin } from "@opencode/plugin"
import { relative, resolve, isAbsolute } from "node:path"
import { realpath } from "node:fs/promises"

const actions = new Set(["read", "glob", "grep", "edit", "write", "patch"])
const tools = new Set(["read", "glob", "grep", "edit", "write", "patch"])
const mutations = new Set(["edit", "write", "patch"])

export function within(root: string, path: string) {
  const rel = relative(root, resolve(root, path))
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")
}

export function absoluteInterpreter(python: string, base: string) {
  if (!python.includes("/") && !python.includes("\\")) return python
  const path = isAbsolute(python) ? python : resolve(base, python)
  if (!isAbsolute(path)) throw new Error("The Python interpreter path must be absolute.")
  return path
}

// Home and / contain the default state directory without being a source repository.
export function acceptsPrivateState(project: string, state: string, home: string, explicit: boolean) {
  if (!isAbsolute(project) || !isAbsolute(state)) return false
  if (!within(project, state)) return true
  return !explicit && (project === "/" || project === home)
}

export function editorPath(root: string, target: string) {
  const path = relative(root, resolve(root, target)).replaceAll("\\", "/")
  return path === "output/answer.md" || path.startsWith("context/harness/")
}

export function patchPaths(text: string) {
  const paths: string[] = []
  for (const line of text.split(/\r?\n/)) {
    for (const prefix of ["*** Add File: ", "*** Delete File: ", "*** Update File: ", "*** Move to: "]) {
      if (line.startsWith(prefix)) paths.push(line.slice(prefix.length).trim())
    }
  }
  return paths
}

export async function registerWorkerGuards(ctx: Plugin.Context) {
  const worker = async (sessionID: string) => {
    const session = await ctx.session.get({ sessionID })
    return session.metadata?.harness2Worker ? session : undefined
  }
  await ctx.permission.hook("evaluate", async (event) => {
    const session = await worker(event.sessionID)
    if (!session) {
      if (event.action.startsWith("harness2.") && event.effect !== "deny") event.effect = "ask"
      return
    }
    // A task worker loads an auxiliary skill on demand, as the method's surface declares. An editor reads them as files.
    if (event.action === "skill") {
      if (session.metadata?.harness2Role !== "task") event.effect = "deny"
      else if (event.effect !== "deny") event.effect = "allow"
      return
    }
    if (!actions.has(event.action)) { event.effect = "deny"; return }
    if (mutations.has(event.action) && session.metadata?.harness2Role === "editor") {
      const root = session.location.directory
      if (event.resources.some((resource) => !editorPath(root, resource))) event.effect = "deny"
    }
  })
  await ctx.session.hook("context", async (event) => {
    const session = await worker(event.sessionID)
    if (!session) return
    const task = session.metadata?.harness2Role === "task"
    for (const name of Object.keys(event.tools)) if (!tools.has(name) && !(task && name === "skill")) delete event.tools[name]
  })
  await ctx.session.hook("title", async (event) => {
    if (await worker(event.sessionID)) event.result = "Harness² worker"
  })
  await ctx.tool.hook("execute.before", async (event) => {
    const session = await worker(event.sessionID)
    if (!session) return
    if (!tools.has(event.tool) && !(event.tool === "skill" && session.metadata?.harness2Role === "task")) {
      throw new Error("This tool is not available to a Harness² worker.")
    }
    if (!event.input || typeof event.input !== "object") return
    const input = event.input as Record<string, unknown>
    const root = await realpath(session.location.directory)
    const targets = ["path", "directory", "workdir", "filePath"].flatMap((key) => {
      const value = input[key]
      return typeof value === "string" ? [value] : []
    })
    if (typeof input.patchText === "string") {
      const named = patchPaths(input.patchText)
      if (!named.length) throw new Error("A patch must name every file it changes.")
      targets.push(...named)
    }
    for (const value of targets) {
      if (!within(root, value)) throw new Error("Worker file access cannot leave its own directory.")
      const actual = await realpath(resolve(root, value)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return resolve(root, value)
        throw error
      })
      if (!within(root, actual)) throw new Error("Worker file access cannot follow an external link.")
      if (session.metadata?.harness2Role === "editor" && mutations.has(event.tool) && !editorPath(root, actual)) {
        throw new Error("An editor can change only context/harness and output/answer.md.")
      }
    }
  })
}
