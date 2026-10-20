import { readFile, realpath } from "node:fs/promises"
import { resolve, isAbsolute } from "node:path"
import { createHash } from "node:crypto"
import { within } from "./runtime.ts"

export type Oracle = { files: { path: string; equals: string }[] }

export function validateOracle(oracle: Oracle) {
  if (!oracle || !Array.isArray(oracle.files) || !oracle.files.length || oracle.files.length > 20) throw new Error("Provide between 1 and 20 independent file checks.")
  for (const file of oracle.files) {
    if (typeof file.path !== "string" || isAbsolute(file.path) || typeof file.equals !== "string" || file.equals.length > 100_000 || !within("/oracle", file.path)) {
      throw new Error("Oracle paths must be relative and bounded.")
    }
  }
  return createHash("sha256").update(JSON.stringify(oracle)).digest("hex")
}

export async function evaluateOracle(directory: string, oracle: Oracle) {
  const hash = validateOracle(oracle)
  const root = await realpath(directory)
  const checks = await Promise.all(oracle.files.map(async ({ path, equals }) => {
    try {
      const target = await realpath(resolve(root, path))
      if (!within(root, target)) throw new Error("Oracle target escapes its snapshot.")
      const body = await readFile(target)
      return { path, passed: body.length <= 1_000_000 && body.toString("utf8") === equals }
    } catch { return { path, passed: false } }
  }))
  return { oracleSha256: hash, passed: checks.filter((check) => check.passed).length, total: checks.length, checks }
}

export async function pilotReport(result: Record<string, unknown>, oracle: Oracle) {
  const directories = result.baselineDirectories as string[]
  const adopted = result.adopted as { directory?: string }
  const baseline = await Promise.all((directories ?? []).map((directory) => evaluateOracle(resolve(directory, "workspace"), oracle)))
  const final = adopted?.directory ? await evaluateOracle(resolve(adopted.directory, "workspace"), oracle) : null
  return { baseline, final, limitation: "File equality only. This single run does not establish a general quality or speed improvement." }
}
