# pi-upgrade

A [pi](https://github.com/badlogic/pi-mono) extension that adds an `/upgrade` command for upgrading the core `pi-coding-agent` CLI to the latest npm release.

## Install

```bash
pi install npm:pi-upgrade
```

Or from GitHub:

```bash
pi install git:github.com/maxpetretta/pi-upgrade
```

## Usage

```text
/upgrade
```

Flags:

- `/upgrade --force` — reinstall even if already on latest
- `/upgrade --dry-run` — show what would run without doing it

### What it does

1. Finds the running `pi` binary and walks up to its `package.json`
2. Detects the package manager from the install path (npm, pnpm, yarn, bun)
3. Prefers the package manager sibling to the current Node runtime
4. Checks the npm registry for the latest published version
5. Runs the appropriate global install command
6. Tells you to restart pi afterward

### Why restart?

`/reload` only reloads extensions, skills, prompts, and themes. The core pi runtime is already loaded in memory, so a process restart is needed to pick up the new version.

## Development

This package uses Bun for local development.

```bash
bun install
bun run lint
bun run typecheck
bun test
```

## License

MIT
