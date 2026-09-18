import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

export function defaultDataHome() {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return resolve(process.env.DEV_DATA_HOME ?? join(home, ".local/share/dev"));
}

function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export function projectIdentity(cwd) {
  const commonDir = git(cwd, ["rev-parse", "--git-common-dir"]);
  if (commonDir) return resolve(cwd, commonDir);
  return resolve(cwd);
}

export function gitRoot(cwd) {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

function preferencePath(dataHome, identity) {
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return join(dataHome, "preferences", `${key}.json`);
}

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    throw new Error(`Cannot read dev preference ${path}: ${error.message}`);
  }
}

export function resolveSelection({ cwd, dataHome, explicit }) {
  const identity = projectIdentity(cwd);
  const path = preferencePath(dataHome, identity);
  const saved = readJson(path).specialization;
  return { identity, path, specialization: explicit ?? saved ?? "general", source: explicit ? "temporary override" : saved ? "saved preference" : "general default" };
}

export function saveSelection({ cwd, dataHome, specialization }) {
  const identity = projectIdentity(cwd);
  const path = preferencePath(dataHome, identity);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ specialization, project: identity }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

export function sessionDir(dataHome) {
  const path = join(dataHome, "sessions");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function runtimeLockPath(dataHome) {
  return join(dataHome, "runtime.lock");
}

function removeStaleLock(path) {
  try {
    const { pid } = JSON.parse(readFileSync(path, "utf8"));
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH" || error.code === "ENOENT" || error instanceof SyntaxError) unlinkSync(path);
  }
}

export function assertNoActiveRuntime(dataHome) {
  const path = runtimeLockPath(dataHome);
  if (!existsSync(path)) return;
  removeStaleLock(path);
  if (existsSync(path)) throw new Error(`A dev session is active for ${dataHome}; stop it before updating or rolling back.`);
}

export function acquireRuntime(dataHome) {
  mkdirSync(dataHome, { recursive: true, mode: 0o700 });
  const path = runtimeLockPath(dataHome);
  assertNoActiveRuntime(dataHome);
  const descriptor = openSync(path, "wx", 0o600);
  writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid })}\n`);
  closeSync(descriptor);
  return () => { if (existsSync(path)) unlinkSync(path); };
}
