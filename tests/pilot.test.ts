import assert from "node:assert/strict"
import test from "node:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { evaluateOracle, validateOracle } from "../src/pilot.ts"
import { fixture } from "./fixtures.ts"

test("the independent oracle checks actual file bytes, not a model verdict", async () => {
  const f = await fixture()
  const oracle = { files: [{ path: "result.txt", equals: "correct\n" }] }
  assert.equal((await evaluateOracle(f.repository, oracle)).passed, 0)
  await writeFile(join(f.repository, "result.txt"), "correct\n")
  const report = await evaluateOracle(f.repository, oracle)
  assert.equal(report.passed, 1)
  assert.equal(report.total, 1)
  assert.equal(report.oracleSha256, validateOracle(oracle))
})

test("oracle paths cannot escape the candidate snapshot", () => {
  assert.throws(() => validateOracle({ files: [{ path: "../../private.txt", equals: "" }] }), /relative/)
})
