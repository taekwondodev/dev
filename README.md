<p align="center">
  <img src="docs/logo.png" alt="dev logo" width="200">
</p>

<h1 align="center">dev</h1>

<p align="center">My personal agent distro built on top of <a href="https://github.com/earendil-works/pi">Pi</a>.</p>

## Why I made this

I wanted a terminal-first experience. I was a Hermes main, but I wanted to come back to the terminal, and its CLI was not that enjoyable. So I built the environment I wanted on Pi, which already owns inference, sessions and the TUI, and kept for myself only the parts Pi does not have.

## What it does

- **`dev`** opens Pi from the project you are working on, with a profile (`general` or `apple`) that selects guidance and skills, and keeps private state out of the project and out of Git. [launcher](docs/launcher.md)
- **`work`** runs commands and delegated Pi children in the background, in separate processes, with a versioned model dispatch and outcomes delivered back into the conversation. [work](docs/work.md), [dispatch notes](config/README.md)
- **`workspace`** lets several sessions and their children write to one repository without overwriting each other, allocating worktrees when needed and releasing them once the work is delivered. [workspace](docs/workspace.md)
- The workflow itself (sizing, grilling, specs, implementation, review) comes from a shared skill library; dev owns only the integration.

Why each piece is shaped the way it is: [ARCHITECTURE](docs/ARCHITECTURE.md). What dev trusts and what it does not protect: [SECURITY](SECURITY.md).

## Use dev

Dev is built for me: it assumes a globally installed `pi`, the skill library at `~/.agents/skills`, and Node 22.23.2 or newer with a SQLite that carries the WAL-reset fix. Read [SECURITY](SECURITY.md) before installing.

```bash
cd ~/Developer/dev
npm ci
npm run setup
npm link --ignore-scripts
```

Then, from any Git project:

```bash
cd /path/to/your/project
dev
```

Every flag, the session commands and the maintenance commands are in [launcher](docs/launcher.md). To change dev itself, start from [DEVELOPMENT](docs/DEVELOPMENT.md) and [AGENTS.md](AGENTS.md).

## Performance

Measured on my own use of dev, not on benchmarks: every lead and child session file in my data home, abandoned branches included. Each chart names its sample size and date range.

<p align="center">
  <img src="docs/performance/usage.svg" alt="Lead cache hit rate, median tool calls per lead session, mean children per lead session, p50 model latency and mean tool result size">
</p>

The numbers come from `npm run profile`, which also prints the full report and writes `docs/performance/usage-baseline.json`. Only aggregates are committed: no path, project name or conversation text.
