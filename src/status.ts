export const PLUGIN_ID = "jf3env.harness2"

export function isOpenCode2(version: unknown): version is string {
  return typeof version === "string"
    && /^2\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
}

export function statusFor(version: unknown) {
  if (!isOpenCode2(version)) throw new Error("This integration requires an OpenCode 2 release.")

  return {
    pluginId: PLUGIN_ID,
    opencodeVersion: version,
    stage: "foundation",
    execution: "not_implemented",
    improvement: "not_implemented",
    memory: "not_implemented",
  } as const
}
