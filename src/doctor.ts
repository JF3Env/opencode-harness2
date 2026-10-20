import { checkLocalConnection } from "./client.ts"

try {
  console.log(JSON.stringify(await checkLocalConnection(), null, 2))
} catch {
  console.error("OpenCode 2 connection check failed. Start OpenCode normally and retry. No model request was submitted.")
  process.exitCode = 1
}
