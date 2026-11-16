import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, withMockSdkSessionId, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop } from "./helpers"
import { UpstreamIdleError } from "../proxy/streamIdleGuard"

let stalled = true
installSdkMock(() => ({
  query: (params: { options: { includePartialMessages?: boolean } }) => (async function* () {
    if (stalled) throw new UpstreamIdleError(90_000, 90_001)
    if (params.options.includePartialMessages) {
      for (const event of [messageStart(), textBlockStart(0), textDelta(0, "OK"), blockStop(0), messageDelta(), messageStop()]) {
        yield withMockSdkSessionId(event, params.options)
      }
    }
    yield withMockSdkSessionId(assistantMessage([{ type: "text", text: "OK" }]), params.options)
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "fixture", instance: {} }),
  tool: () => ({}),
}), "proxy-idle-stall-log.test.ts")
installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: <T>(_context: unknown, fn: () => T) => fn(),
}))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))
const { createProxyServer, clearSessionCache } = await import("../proxy/server")
type App = ReturnType<typeof createProxyServer>["app"]

const realError = console.error
let lines: string[] = []

async function request(app: App, session: string, stream: boolean) {
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-opencode-session": session },
    body: JSON.stringify({ model: "haiku", max_tokens: 100, stream, messages: [{ role: "user", content: "hello" }] }),
  }))
  await response.text()
  return response.status
}

function requestIds(): Set<string> {
  return new Set(lines.flatMap((l) => l.match(/^\[PROXY\] ([0-9a-f-]{36}) adapter=/)?.[1] ?? []))
}

describe("idle stalls are always logged as [PROXY] lines", () => {
  beforeEach(() => {
    stalled = true
    clearSessionCache()
    lines = []
    console.error = (...args: unknown[]) => { lines.push(args.join(" ")) }
  })
  afterEach(() => { console.error = realError })

  it.each([false, true])("logs each stall with its verdict under the request id, stream=%s", async (stream) => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const session = crypto.randomUUID()
    for (let attempt = 0; attempt < 3; attempt++) await request(app, session, stream)
    const idle = lines.filter((l) => l.includes(" upstream_idle "))
    expect(idle).toHaveLength(3)
    for (const line of idle) {
      const id = line.match(/^\[PROXY\] ([0-9a-f-]{36}) upstream_idle /)?.[1]
      expect(id && requestIds().has(id)).toBe(true)
      expect(line).toContain(`mode=${stream ? "stream" : "non_stream"}`)
      expect(line).toContain("sinceLastMs=90001 limitMs=90000")
    }
    expect(idle[0]).toMatch(/consecutive=1 ceiling=3 terminal=false status=504 type=upstream_timeout$/)
    expect(idle[2]).toMatch(/consecutive=3 ceiling=3 terminal=true status=400 type=invalid_request_error$/)
  })

  it("logs a retry rejected by the ceiling before the SDK runs", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const session = crypto.randomUUID()
    for (let attempt = 0; attempt < 3; attempt++) await request(app, session, true)
    lines = []
    expect(await request(app, session, true)).toBe(400)
    const blocked = lines.filter((l) => l.includes(" upstream_idle_blocked "))
    expect(blocked).toHaveLength(1)
    expect(blocked[0]).toMatch(/^\[PROXY\] [0-9a-f-]{36} upstream_idle_blocked consecutive=3 status=400 type=invalid_request_error$/)
  })

  it("logs nothing for a request that does not stall", async () => {
    stalled = false
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    expect(await request(app, crypto.randomUUID(), true)).toBe(200)
    expect(lines.some((l) => l.includes("upstream_idle"))).toBe(false)
    expect(lines.some((l) => / adapter=\S+ .* lineage=/.test(l))).toBe(true)
  })
})
