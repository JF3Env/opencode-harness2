import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { isOpenCode2 } from "./status.ts"

export async function checkLocalConnection(
  discover: typeof Service.discover = Service.discover,
  fetch?: typeof globalThis.fetch,
) {
  const endpoint = await discover({ version: isOpenCode2 })
  if (!endpoint) throw new Error("No compatible OpenCode 2 service is available. Start OpenCode normally and retry.")

  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers({
      url: endpoint.url,
      ...(endpoint.auth ? { auth: endpoint.auth } : {}),
    }),
    ...(fetch ? { fetch } : {}),
  })
  const info = await client.server.info({ signal: AbortSignal.timeout(10_000) })
  if (!isOpenCode2(info.version)) throw new Error("The connected service is not an OpenCode 2 release.")

  return {
    connected: true,
    opencodeVersion: info.version,
    modelAccess: "not_exercised",
    harnessCycle: "not_implemented",
  } as const
}
