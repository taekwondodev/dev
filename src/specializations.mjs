import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const home = process.env.HOME ?? process.env.USERPROFILE;
const sharedSkills = resolve(home, "Developer/skills/skills");
const appleSkills = resolve(home, ".hermes/profiles/apple-dev/skills");

const specializations = {
  general: {
    name: "general",
    required: [{ label: "shared workflow skills", path: sharedSkills }],
    skillPaths: [sharedSkills],
    guidance: "Work as a general-purpose software development assistant. Load domain guidance only when its trigger applies.",
  },
  apple: {
    name: "apple",
    required: [
      { label: "shared workflow skills", path: sharedSkills },
      { label: "Apple development skills", path: appleSkills },
    ],
    skillPaths: [appleSkills, sharedSkills],
    guidance: "Use the Apple development specialization for Apple-platform work while retaining the shared development workflow as the source of truth.",
  },
};

export function specializationNames() {
  return Object.keys(specializations);
}

export function getSpecialization(name) {
  const specialization = specializations[name];
  if (!specialization) {
    throw new Error(`Unknown specialization "${name}". Choose one of: ${specializationNames().join(", ")}.`);
  }
  const missing = specialization.required.filter(({ path }) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(`Specialization "${name}" is unavailable; missing ${missing.map(({ label, path }) => `${label} at ${path}`).join(", ")}. Use --specialization general or restore the resource.`);
  }
  return specialization;
}

function projectSkillPaths(cwd, gitRoot) {
  const paths = [];
  let current = resolve(cwd);
  const stop = gitRoot ? resolve(gitRoot) : null;
  while (true) {
    for (const folder of [".pi/skills", ".agents/skills"]) {
      const path = join(current, folder);
      if (existsSync(path)) paths.push(path);
    }
    if (stop ? current === stop : current === resolve(current, "..")) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
    if (stop && current === stop) {
      for (const folder of [".pi/skills", ".agents/skills"]) {
        const path = join(current, folder);
        if (existsSync(path)) paths.push(path);
      }
      break;
    }
  }
  return paths;
}

export function composeResources({ cwd, gitRoot, specialization }) {
  const projectPaths = projectSkillPaths(cwd, gitRoot);
  const seen = new Set();
  const paths = [...projectPaths, ...specialization.skillPaths].filter((path) => {
    const canonical = realpathSync(path);
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
  const provenance = paths.flatMap((path, index) => {
    const source = index < projectPaths.length ? "project" : specialization.name;
    return [{ path, source, precedence: index }];
  });
  return { skillPaths: paths, provenance, guidance: specialization.guidance };
}

export function resourceSummary(resources) {
  return resources.provenance.map(({ source, path }) => `${source}: ${path}`).join("\n");
}
