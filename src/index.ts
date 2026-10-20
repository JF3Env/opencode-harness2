import { Plugin } from "@opencode/plugin"
import { PLUGIN_ID, statusFor } from "./status.ts"

export function createStatusTool(version: string) {
  const status = statusFor(version)
  return {
    name: "harness2_status",
    description: "Report the Harness² integration stage. This tool does not run tasks or call models.",
    input: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      return { content: JSON.stringify(status) }
    },
  }
}

type StatusContext = {
  app: Pick<Plugin.Context["app"], "version">
  tool: Pick<Plugin.Context["tool"], "transform">
}

export async function registerStatus(ctx: StatusContext) {
  const tool = createStatusTool(ctx.app.version)
  await ctx.tool.transform((editor) => editor.add(tool))
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup: registerStatus,
})
