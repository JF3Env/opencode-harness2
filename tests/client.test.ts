import assert from "node:assert/strict"
import test from "node:test"
import { checkLocalConnection } from "../src/client.ts"

const endpoint = {
  url: "http://127.0.0.1:4096",
  auth: { type: "basic" as const, username: "fixture", password: "synthetic-test-password" },
}

function serverInfo(version = "2.0.32") {
  return { version, pid: 123, urls: [endpoint.url], paths: { tmp: "/synthetic/private/path" } }
}

test("the connection check uses one authenticated read and returns only a safe summary", async () => {
  const requests: Request[] = []
  const result = await checkLocalConnection(
    async (options) => {
      assert.equal(typeof options?.version, "function")
      if (typeof options?.version !== "function") assert.fail("A version predicate is required.")
      assert.equal(options.version("2.0.32"), true)
      assert.equal(options.version("1.14.18"), false)
      return endpoint
    },
    async (input, init) => {
      requests.push(new Request(input, init))
      return Response.json(serverInfo())
    },
  )
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.method, "GET")
  assert.equal(new URL(requests[0]!.url).pathname, "/api/info")
  assert.equal(requests[0]?.headers.get("authorization"),
    `Basic ${Buffer.from("fixture:synthetic-test-password").toString("base64")}`)
  assert.ok(requests[0]?.signal)
  assert.deepEqual(result, {
    connected: true,
    opencodeVersion: "2.0.32",
    modelAccess: "not_exercised",
    harnessCycle: "not_implemented",
  })
  assert.equal(JSON.stringify(result).includes("synthetic"), false)
})

test("a missing service does not start one or send an HTTP request", async () => {
  await assert.rejects(checkLocalConnection(
    async () => undefined,
    async () => assert.fail("A missing service must not trigger an HTTP request."),
  ), /No compatible OpenCode 2 service/)
})

test("a service without authentication omits the optional credential", async () => {
  const result = await checkLocalConnection(
    async () => ({ url: endpoint.url, auth: undefined }),
    async (input, init) => {
      const request = new Request(input, init)
      assert.equal(request.headers.has("authorization"), false)
      return Response.json(serverInfo())
    },
  )
  assert.equal(result.connected, true)
})

test("an incompatible live service cannot pass through stale discovery metadata", async () => {
  await assert.rejects(checkLocalConnection(
    async () => endpoint,
    async () => Response.json(serverInfo("1.14.18")),
  ), /not an OpenCode 2 release/)
})

test("authentication failures propagate instead of reporting a healthy connection", async () => {
  await assert.rejects(checkLocalConnection(
    async () => endpoint,
    async () => new Response("Unauthorized", { status: 401 }),
  ))
})

test("invalid server output does not count as a successful connection", async () => {
  await assert.rejects(checkLocalConnection(
    async () => endpoint,
    async () => Response.json({ ok: true }),
  ), /not an OpenCode 2 release/)
})

test("transport errors propagate without a fallback model request", async () => {
  let requests = 0
  await assert.rejects(checkLocalConnection(
    async () => endpoint,
    async () => {
      requests += 1
      throw new Error("Synthetic transport failure")
    },
  ), /Synthetic transport failure/)
  assert.equal(requests, 1)
})
