// Runs in its own `bun test` invocation (see package.json): the idle limit is
// read when server.ts loads, so it must be set before any other file imports it.
process.env.MERIDIAN_UPSTREAM_IDLE_MS = "50"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { withMockSdkSessionId, messageStart } from "./helpers"

installSdkMock(() => ({
  query: (params: { options: { includePartialMessages?: boolean } }) => (async function* () {
    if (params.options.includePartialMessages) yield withMockSdkSessionId(messageStart(), params.options)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "fixture", instance: {} }),
  tool: () => ({}),
}), "proxy-upstream-stalled-log.test.ts")
installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: <T>(_context: unknown, fn: () => T) => fn(),
}))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))
const { createProxyServer, clearSessionCache } = await import("../proxy/server")

const realError = console.error
let lines: string[] = []

describe("an upstream that goes silent past the idle limit", () => {
  beforeEach(() => {
    clearSessionCache()
    lines = []
    console.error = (...args: unknown[]) => { lines.push(args.join(" ")) }
  })
  afterEach(() => { console.error = realError })

  it.each([false, true])("logs the stall itself under the request id, stream=%s", async (stream) => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-opencode-session": crypto.randomUUID() },
      body: JSON.stringify({ model: "haiku", max_tokens: 100, stream, messages: [{ role: "user", content: "hello" }] }),
    }))
    await response.text()
    const id = lines.map((l) => l.match(/^\[PROXY\] ([0-9a-f-]{36}) adapter=/)?.[1]).find(Boolean)
    const stalled = lines.filter((l) => l.includes(" upstream_stalled "))
    expect(stalled).toHaveLength(1)
    expect(stalled[0]).toMatch(new RegExp(`^\\[PROXY\\] ${id} upstream_stalled mode=${stream ? "stream" : "non_stream"} sinceLastMs=\\d+ limitMs=50$`))
    expect(lines.some((l) => l.startsWith(`[PROXY] ${id} upstream_idle `))).toBe(true)
  })
})
