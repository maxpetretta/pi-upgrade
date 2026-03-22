import { spawnSync } from "node:child_process"
import { existsSync, promises as fs, constants as fsConstants } from "node:fs"
import path from "node:path"
import {
  type ExecResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
  SettingsManager,
} from "@mariozechner/pi-coding-agent"
import { Text } from "@mariozechner/pi-tui"

export const PACKAGE_NAME = "@mariozechner/pi-coding-agent"
export const UPGRADE_TIMEOUT_MS = 600_000
export const UPGRADE_WIDGET_ID = "pi-upgrade-status"

export type Manager = "npm" | "pnpm" | "yarn" | "bun"
export type UpgradePlan = { manager: Manager; command: string; args: string[]; reason: string }
export type InstallInfo = {
  packageRoot: string | null
  currentVersion: string | null
  isPackagedInstall: boolean
  plan: UpgradePlan
}

type ManagerRule = {
  manager: Manager
  matches(paths: string[]): boolean
  args: string[]
  candidates: string[]
  reason: string
}

type NpmCommand = {
  command: string
  args: string[]
}

type NpmCommandReader = {
  getNpmCommand(): string[] | undefined
}

export type CommandLocator = (name: string) => Promise<string | null>

function siblingExec(name: string, ext = process.platform === "win32" ? ".cmd" : ""): string {
  return path.join(path.dirname(process.execPath), `${name}${ext}`)
}

const MANAGER_RULES: ManagerRule[] = [
  {
    manager: "bun",
    matches: (paths) => paths.some((p) => p.includes("/.bun/")),
    args: ["add", "-g", `${PACKAGE_NAME}@latest`],
    candidates: [siblingExec("bun", process.platform === "win32" ? ".exe" : ""), "bun"],
    reason: "Install path matches Bun global layout.",
  },
  {
    manager: "pnpm",
    matches: (paths) => paths.some((p) => p.includes("/pnpm/") || p.includes("/.pnpm/")),
    args: ["add", "-g", `${PACKAGE_NAME}@latest`],
    candidates: [siblingExec("pnpm"), "pnpm"],
    reason: "Install path matches pnpm global layout.",
  },
  {
    manager: "yarn",
    matches: (paths) => paths.some((p) => p.includes("/yarn/")),
    args: ["global", "add", `${PACKAGE_NAME}@latest`],
    candidates: [siblingExec("yarn"), "yarn"],
    reason: "Install path matches Yarn global layout.",
  },
  {
    manager: "npm",
    matches: () => true,
    args: ["install", "-g", `${PACKAGE_NAME}@latest`],
    candidates: [siblingExec("npm"), "npm"],
    reason: "Defaulting to npm.",
  },
]

export default function upgradeExtension(pi: ExtensionAPI) {
  pi.registerCommand("upgrade", {
    description: "Upgrade pi to the latest version",
    handler: async (rawArgs, ctx) => {
      const flags = new Set((rawArgs || "").split(/\s+/).filter(Boolean))
      const force = flags.has("--force")
      const dryRun = flags.has("--dry-run")

      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Waiting for pi to become idle before upgrading...", "info")
        await ctx.waitForIdle()
      }

      const install = await detectInstall((name) => which(pi, name))
      if (!(install.packageRoot && install.isPackagedInstall)) {
        ctx.ui.notify(
          [
            "Could not safely detect a packaged pi install.",
            "This looks like a local/dev or otherwise unusual setup.",
            `Current entry: ${process.argv[1] ?? "unknown"}`,
            "Please upgrade manually.",
          ].join("\n"),
          "error",
        )
        return
      }

      const latestVersion = await fetchLatestVersion()
      const commandLine = formatCommand(install.plan.command, install.plan.args)
      const alreadyLatest = !!install.currentVersion && !!latestVersion && install.currentVersion === latestVersion
      const details = [
        `Detected manager: ${install.plan.manager}`,
        `Reason: ${install.plan.reason}`,
        install.currentVersion ? `Current version: v${install.currentVersion}` : "Current version: unknown",
        latestVersion ? `Latest version: v${latestVersion}` : "Latest version: unavailable",
        `Install path: ${install.packageRoot}`,
        "",
        "Will run:",
        commandLine,
      ].join("\n")

      if (dryRun) {
        ctx.ui.notify(
          [
            "Dry run — no changes made.",
            "",
            details,
            "\nWould restart pi on the current session after the upgrade.",
            alreadyLatest && !force ? "\npi is already up to date." : "",
          ]
            .filter(Boolean)
            .join("\n"),
          "info",
        )
        return
      }

      if (!force && alreadyLatest) {
        ctx.ui.notify(`pi is already up to date (v${install.currentVersion}).`, "info")
        return
      }

      const canAutoRestart = supportsAutoRestart(ctx)
      if (canAutoRestart) {
        setUpgradeWidget(ctx, [
          `Upgrading pi via ${install.plan.manager}...`,
          `Install: ${buildInstallTypeLabel(install.plan.manager)}`,
        ])
      } else {
        ctx.ui.notify(`Upgrading pi via ${install.plan.manager}...\n\n${commandLine}`, "info")
      }

      let result: ExecResult
      try {
        result = await pi.exec(install.plan.command, install.plan.args, { timeout: UPGRADE_TIMEOUT_MS })
      } catch (error) {
        if (canAutoRestart) clearUpgradeWidget(ctx)
        ctx.ui.notify(
          `Upgrade failed to start.\n${error instanceof Error ? error.message : error}\n\nCommand:\n${commandLine}`,
          "error",
        )
        return
      }

      if (result.code !== 0) {
        if (canAutoRestart) clearUpgradeWidget(ctx)
        ctx.ui.notify(
          ["Upgrade failed.", `Command: ${commandLine}`, "", tailText(result.stderr || result.stdout)].join("\n"),
          "error",
        )
        return
      }

      const updated = await detectInstall((name) => which(pi, name))
      const message =
        updated.currentVersion && install.currentVersion !== updated.currentVersion
          ? `Updated pi from v${install.currentVersion} to v${updated.currentVersion}.`
          : updated.currentVersion
            ? `pi is at v${updated.currentVersion}.`
            : "pi was upgraded."

      if (!canAutoRestart) {
        ctx.ui.notify(
          [message, "Please restart to use the new version.", "Tip: run `pi -c` to continue your last session."].join(
            "\n",
          ),
          "info",
        )
        return
      }

      const restartResult = await restartPi(pi, ctx, message)
      if (restartResult.ok) {
        ctx.shutdown()
        return
      }

      clearUpgradeWidget(ctx)
      ctx.ui.notify(
        [
          message,
          "Auto-restart failed.",
          restartResult.error,
          "Please restart pi manually.",
          "Tip: run `pi -c` to continue your last session.",
        ]
          .filter(Boolean)
          .join("\n"),
        "error",
      )
    },
  })
}

export async function detectInstall(
  findCommand: CommandLocator,
  currentEntry = process.argv[1] ?? null,
): Promise<InstallInfo> {
  const piBinaryPath = await findCommand("pi")
  const piRealPath = piBinaryPath ? await realpath(piBinaryPath) : null
  const packageRoot = (await findPackageRoot(piRealPath)) ?? (await findPackageRoot(currentEntry))
  const pkg = packageRoot ? await readJson(path.join(packageRoot, "package.json")) : null

  return {
    packageRoot,
    currentVersion: typeof pkg?.version === "string" ? pkg.version : null,
    isPackagedInstall: isPackagedInstall(packageRoot),
    plan: await buildUpgradePlan(findCommand, [packageRoot, piBinaryPath, piRealPath]),
  }
}

export async function buildUpgradePlan(findCommand: CommandLocator, paths: Array<string | null>): Promise<UpgradePlan> {
  const normalized = paths.map(normalizePath)
  const rule = MANAGER_RULES.find((entry) => entry.matches(normalized))
  if (!rule) throw new Error("No matching manager rule found")

  if (rule.manager === "npm") {
    const configuredNpmCommand = getConfiguredNpmCommand()
    if (configuredNpmCommand) {
      return {
        manager: "npm",
        command: configuredNpmCommand.command,
        args: [...configuredNpmCommand.args, ...rule.args],
        reason: "Using configured npmCommand from settings.",
      }
    }
  }

  return {
    manager: rule.manager,
    command: await resolveCommand(findCommand, rule.candidates),
    args: rule.args,
    reason: rule.reason,
  }
}

export async function fetchLatestVersion(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`, {
      headers: { accept: "application/json" },
    })
    if (!response.ok) return null
    const data = (await response.json()) as { version?: unknown }
    return typeof data.version === "string" ? data.version : null
  } catch {
    return null
  }
}

export async function findPackageRoot(start: string | null): Promise<string | null> {
  if (!start) return null

  let dir = path.resolve(start)
  try {
    if (!(await fs.stat(dir)).isDirectory()) dir = path.dirname(dir)
  } catch {
    dir = path.dirname(dir)
  }

  for (;;) {
    const pkg = await readJson(path.join(dir, "package.json"))
    if (pkg?.name === PACKAGE_NAME) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function isPackagedInstall(packageRoot: string | null): boolean {
  return normalizePath(packageRoot).includes(`/node_modules/${PACKAGE_NAME}`)
}

export function normalizePath(value: string | null): string {
  return (value ?? "").replace(/\\/g, "/")
}

export function formatCommand(command: string, args: string[]): string {
  const quote = (value: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value))
  return [command, ...args].map(quote).join(" ")
}

export function buildRestartArgs(sessionFile: string | undefined): string[] {
  return sessionFile ? ["--session", sessionFile] : ["-c"]
}

export function buildRestartCommand(
  piBinary: string,
  sessionFile: string | undefined,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  const restartArgs = buildRestartArgs(sessionFile)
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", formatCommand(piBinary, restartArgs)],
    }
  }

  return {
    command: piBinary,
    args: restartArgs,
  }
}

export function buildInstallTypeLabel(manager: Manager): string {
  return `${manager} global package`
}

export function buildRestartCountdownLines(message: string, secondsRemaining: number): string[] {
  return [message, "Please restart to use the new version.", `Restarting pi in ${secondsRemaining}s`]
}

export function tailText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return "No output."
  const tail = trimmed.split(/\r?\n/).slice(-20).join("\n")
  return tail.length > 3000 ? tail.slice(-3000) : tail
}

export function getConfiguredNpmCommand(
  createSettingsManager = (): NpmCommandReader => SettingsManager.create(),
): NpmCommand | null {
  try {
    const configuredCommand = createSettingsManager().getNpmCommand()
    if (!configuredCommand || configuredCommand.length === 0) return null

    const [command, ...args] = configuredCommand
    if (!command) return null

    return { command, args }
  } catch {
    return null
  }
}

function supportsAutoRestart(ctx: ExtensionCommandContext): boolean {
  return ctx.hasUI && !!process.stdin.isTTY && !!process.stdout.isTTY
}

function setUpgradeWidget(ctx: ExtensionCommandContext, lines: string[] | undefined): void {
  ctx.ui.setWidget(
    UPGRADE_WIDGET_ID,
    lines
      ? (_tui, theme) =>
          new Text(
            lines.map((line, index) => (index === 2 ? theme.fg("text", line) : theme.fg("muted", line))).join("\n"),
            0,
            0,
          )
      : undefined,
  )
}

function clearUpgradeWidget(ctx: ExtensionCommandContext): void {
  setUpgradeWidget(ctx, undefined)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function restartPi(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  message: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let secondsRemaining = 5; secondsRemaining >= 0; secondsRemaining -= 1) {
    setUpgradeWidget(ctx, buildRestartCountdownLines(message, secondsRemaining))
    if (secondsRemaining > 0) await sleep(1000)
  }

  const piBinary = (await which(pi, "pi")) ?? "pi"
  const restartCommand = buildRestartCommand(piBinary, ctx.sessionManager.getSessionFile())

  return ctx.ui.custom<{ ok: true } | { ok: false; error: string }>((tui, _theme, _kb, done) => {
    tui.stop()

    const result = spawnSync(restartCommand.command, restartCommand.args, {
      cwd: ctx.cwd,
      env: process.env,
      stdio: "inherit",
      windowsHide: false,
    })

    tui.start()
    tui.requestRender(true)

    if (result.error) {
      done({ ok: false, error: result.error.message })
    } else if (typeof result.status === "number" && result.status !== 0) {
      done({ ok: false, error: `Restarted pi exited with code ${result.status}.` })
    } else {
      done({ ok: true })
    }

    return {
      render: () => [],
      invalidate: () => {
        // No-op.
      },
    }
  })
}

async function which(pi: ExtensionAPI, name: string): Promise<string | null> {
  const command = process.platform === "win32" ? "where" : "which"
  const result = await pi.exec(command, [name])
  if (result.code !== 0 || !result.stdout) return null

  const matches = result.stdout.trim().split(/\r?\n/).filter(Boolean)

  if (process.platform === "win32") {
    return matches.find((match) => existsSync(match)) ?? null
  }

  return matches[0] ?? null
}

async function resolveCommand(findCommand: CommandLocator, candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      try {
        await fs.access(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        continue
      }
    }

    const found = await findCommand(candidate)
    if (found) return found
  }

  return candidates.at(-1) ?? "npm"
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch {
    return null
  }
}

async function realpath(target: string): Promise<string> {
  try {
    return await fs.realpath(target)
  } catch {
    return target
  }
}
