import { spawn } from "node:child_process"
import { realpath } from "node:fs/promises"
import { relative, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import type { WorkerRequest } from "./runner.ts"

export async function contained(root: string, directory: string) {
  const path = relative(await realpath(root), await realpath(directory))
  if (isAbsolute(path) || path === ".." || path.startsWith("../")) throw new Error("The worker directory escapes its private run.")
}

export async function runBridge(
  python: string,
  input: Record<string, unknown>,
  execute: (request: WorkerRequest) => Promise<unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  signal.throwIfAborted()
  const child = spawn(python, ["-I", "-B", fileURLToPath(new URL("../python/controller.py", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", HARNESS2_RUNS_DIR: String(input.runRoot) },
  })
  let buffer = ""
  let stderr = ""
  let final: Record<string, unknown> | undefined
  let failure: Error | undefined
  const abort = () => {
    child.kill("SIGTERM")
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000)
    timer.unref()
    child.once("close", () => clearTimeout(timer))
  }
  signal.addEventListener("abort", abort, { once: true })
  const close = new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => code === 0 && !failure ? resolve() : reject(failure ?? new Error(`The Harness² controller exited ${code}. ${stderr.slice(-2000)}`)))
  })
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_000) })
  const tasks = new Set<Promise<void>>()
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk
    if (buffer.length > 8_000_000) { failure = new Error("Controller output exceeded its limit."); abort(); return }
    for (;;) {
      const end = buffer.indexOf("\n")
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      let message: Record<string, unknown>
      try { message = JSON.parse(line) as Record<string, unknown> } catch { failure = new Error("Invalid controller protocol."); abort(); return }
      if (message.type === "result") { final = message.result as Record<string, unknown>; continue }
      if (message.type !== "execute" || typeof message.id !== "string") { failure = new Error("Unexpected controller message."); abort(); return }
      const task = (async () => {
        try {
          const request = message.request as WorkerRequest
          if (!request || typeof request.directory !== "string" || typeof request.text !== "string"
            || !["task", "editor"].includes(request.role) || typeof request.label !== "string") throw new Error("Invalid worker request.")
          await contained(String(input.runRoot), request.directory)
          const result = await execute(request)
          if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ id: message.id, result }) + "\n")
        } catch (error) {
          if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ id: message.id, error: error instanceof Error ? error.message : "Worker failed." }) + "\n")
        }
      })()
      tasks.add(task)
      void task.then(() => tasks.delete(task), () => { tasks.delete(task); failure = new Error("The controller response could not be delivered."); abort() })
    }
  })
  child.stdin.on("error", () => {})
  child.stdin.write(JSON.stringify(input) + "\n")
  try {
    await close
    await Promise.all(tasks)
    signal.throwIfAborted()
    if (!final) throw new Error("The controller did not return a result.")
    return final
  } finally { signal.removeEventListener("abort", abort); child.stdin.destroy() }
}
