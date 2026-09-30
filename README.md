<p align="center">
  <img src="docs/assets/logo.png" alt="dev logo" width="160">
</p>

<h1 align="center">dev</h1>

<p align="center">My personal agent distro built on top of <a href="https://github.com/earendil-works/pi">Pi</a>.</p>

## Why I made this

I wanted a terminal-first experience. I was a Hermes main, but I wanted to come back to the terminal, and its CLI was not that enjoyable. So I built the environment I wanted on Pi, which already owns inference, sessions and the TUI, and kept for myself only the parts Pi does not have.

## What it does

- **`dev`** opens Pi from the project you are working on, with a profile (`general` or `apple`) that selects guidance and skills, and keeps private state out of the project and out of Git. [launcher](docs/launcher.md)
- **`work`** runs commands and delegated Pi children in the background, in separate processes, with a versioned model dispatch and outcomes delivered back into the conversation. [work](docs/work.md)
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

Then, from any project:

```bash
cd /path/to/your/project
dev
```

Every flag, the session commands and the maintenance commands are in [launcher](docs/launcher.md). To change dev itself, start from [DEVELOPMENT](docs/DEVELOPMENT.md) and [AGENTS.md](AGENTS.md).

## Performance

Still no benchmark or performance data. I am collecting data on my own usage, not on useless benchmarks.
