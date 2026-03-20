import { afterEach, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { ExecResult, ExtensionAPI } from "@mariozechner/pi-coding-agent"
import upgradeExtension, {
  buildUpgradePlan,
  findPackageRoot,
  formatCommand,
  getConfiguredNpmCommand,
  isPackagedInstall,
  PACKAGE_NAME,
  tailText,
} from "./upgrade.ts"

afterEach(() => {
  mock.restore()
})

test("buildUpgradePlan detects bun installs from path heuristics", async () => {
  const plan = await buildUpgradePlan(
    async (name) => (name === "bun" ? "/opt/homebrew/bin/bun" : null),
    ["/tmp/.bun/install/global/node_modules/@mariozechner/pi-coding-agent"],
  )

  expect(plan.manager).toBe("bun")
  expect(plan.command).toContain("bun")
  expect(plan.args).toEqual(["add", "-g", `${PACKAGE_NAME}@latest`])
})

test("buildUpgradePlan falls back to npm when no specialized layout matches", async () => {
  const plan = await buildUpgradePlan(
    async (name) => (name === "npm" ? "/usr/bin/npm" : null),
    ["/tmp/lib/node_modules/foo"],
  )

  expect(plan.manager).toBe("npm")
  expect(plan.command).toBe("/usr/bin/npm")
  expect(plan.args).toEqual(["install", "-g", `${PACKAGE_NAME}@latest`])
})

test("findPackageRoot finds the pi package root by walking upward", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-upgrade-core-"))
  try {
    const packageRoot = path.join(tempRoot, "lib", "node_modules", PACKAGE_NAME)
    const distDir = path.join(packageRoot, "dist")
    await mkdir(distDir, { recursive: true })
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "0.60.0" }))
    await writeFile(path.join(distDir, "cli.js"), "")

    expect(await findPackageRoot(path.join(distDir, "cli.js"))).toBe(packageRoot)
    expect(isPackagedInstall(packageRoot)).toBe(true)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test("getConfiguredNpmCommand parses configured wrapper commands", () => {
  const command = getConfiguredNpmCommand(() => ({
    getNpmCommand: () => ["mise", "exec", "node@20", "--", "npm"],
  }))

  expect(command).toEqual({
    command: "mise",
    args: ["exec", "node@20", "--", "npm"],
  })
})

test("formatCommand quotes arguments with spaces", () => {
  expect(formatCommand("npm", ["install", "pkg with spaces"])).toBe('npm install "pkg with spaces"')
})

test("tailText returns a readable final slice", () => {
  const input = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n")
  const output = tailText(input)

  const lines = output.split("\n")
  expect(lines[0]).toBe("line-11")
  expect(lines.at(-1)).toBe("line-30")
  expect(lines).toHaveLength(20)
  expect(tailText("   ")).toBe("No output.")
})

test("registers /upgrade and dry-run reports the detected command", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-upgrade-smoke-"))
  const packageRoot = path.join(tempRoot, ".bun", "install", "global", "node_modules", PACKAGE_NAME)
  const cliPath = path.join(packageRoot, "dist", "cli.js")
  const notifications: Array<{ message: string; type?: string }> = []
  const originalFetch = globalThis.fetch

  try {
    await mkdir(path.dirname(cliPath), { recursive: true })
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "0.60.0" }))
    await writeFile(cliPath, "")

    type TestCommandContext = {
      isIdle(): boolean
      hasPendingMessages(): boolean
      waitForIdle(): Promise<void>
      ui: {
        notify(message: string, type?: string): void
      }
    }

    const commands = new Map<string, (args: string, ctx: TestCommandContext) => Promise<void>>()
    const exec = (command: string, args: string[]): Promise<ExecResult> => {
      if ((command === "which" || command === "where") && args[0] === "pi") {
        return Promise.resolve({ stdout: `${cliPath}\n`, stderr: "", code: 0, killed: false })
      }
      if ((command === "which" || command === "where") && args[0] === "bun") {
        return Promise.resolve({ stdout: `${process.execPath}\n`, stderr: "", code: 0, killed: false })
      }
      return Promise.resolve({ stdout: "", stderr: "not found", code: 1, killed: false })
    }

    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: TestCommandContext) => Promise<void> }) {
        commands.set(name, options.handler)
      },
      exec,
    } as unknown as ExtensionAPI

    const fetchSpy = mock(() => Promise.resolve(new Response(JSON.stringify({ version: "0.60.0" }), { status: 200 })))
    globalThis.fetch = fetchSpy as typeof fetch

    upgradeExtension(pi)

    const handler = commands.get("upgrade")
    expect(handler).toBeDefined()
    if (!handler) throw new Error("/upgrade command was not registered")

    await handler("--dry-run", {
      isIdle: () => true,
      hasPendingMessages: () => false,
      waitForIdle: () => Promise.resolve(),
      ui: {
        notify(message: string, type?: string) {
          notifications.push(type === undefined ? { message } : { message, type })
        },
      },
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.message).toContain("Dry run")
    expect(notifications[0]?.message).toContain("Detected manager: bun")
    expect(notifications[0]?.message).toContain("bun add -g @mariozechner/pi-coding-agent@latest")
    expect(notifications[0]?.type).toBe("info")
  } finally {
    globalThis.fetch = originalFetch
    await rm(tempRoot, { recursive: true, force: true })
  }
})
