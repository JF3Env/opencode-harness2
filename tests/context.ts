import type { Plugin } from "@opencode/plugin"
import type { SessionInfo } from "@opencode/client"
import { join } from "node:path"
import assert from "node:assert/strict"

// These fixtures mirror registration callbacks. They do not emulate a running OpenCode server.
type Handler = (event: any) => unknown
type Tool = { name: string; execute: (input: unknown, context: { sessionID: string; signal: AbortSignal }) => Promise<{ content: string }> }
type Command = { name: string; execute: Handler }

export function context(source: SessionInfo, state: string) {
  const hooks = new Map<string, Handler[]>()
  const tools = new Map<string, Tool>()
  const commands = new Map<string, Command>()
  const approvals: unknown[] = []
  const synthetic: any[] = []
  const register = (domain: string) => async (name: string, callback: Handler) => {
    const key = `${domain}.${name}`
    hooks.set(key, [...(hooks.get(key) ?? []), callback])
    return { dispose: async () => {} }
  }
  const unexpected = () => assert.fail("The plugin must not rewrite existing registry entries or generation settings.")
  const value = {
    app: { name: "opencode", version: "2.0.32", channel: "fixture" },
    options: { stateDirectory: state, python: join(process.cwd(), ".venv", "bin", "python") },
    location: { directory: source.location.directory, project: { canonical: source.location.directory, directory: source.location.directory, id: source.projectID } },
    tool: { hook: register("tool"), transform: async (callback: Handler) => {
      callback({ add: (tool: Tool) => tools.set(tool.name, tool), list: unexpected, get: unexpected, update: unexpected, remove: unexpected, namespace: unexpected })
      return { dispose: async () => {} }
    } },
    command: { transform: async (callback: Handler) => {
      callback({ add: (command: Command) => commands.set(command.name, command) })
      return { dispose: async () => {} }
    } },
    permission: { hook: register("permission"), assert: async (input: unknown) => { approvals.push(input) } },
    session: { get: async () => source, hook: register("session"), synthetic: async (input: unknown) => { synthetic.push(input) } },
  }
  const ctx = new Proxy(value, { get(target, property) {
    if (!(property in target)) throw new Error(`Unexpected context access: ${String(property)}`)
    return Reflect.get(target, property)
  } }) as unknown as Plugin.Context
  return { ctx, hooks, tools, commands, approvals, synthetic,
    async invoke(name: string, input: unknown) { return JSON.parse((await tools.get(name)!.execute(input, { sessionID: source.id, signal: new AbortController().signal })).content) },
    async hook(name: string, event: any) { for (const callback of hooks.get(name) ?? []) await callback(event); return event },
  }
}
