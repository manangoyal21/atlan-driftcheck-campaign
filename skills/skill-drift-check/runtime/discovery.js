import { access, lstat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashTree } from "./hash.js";
const PROJECT_ROOTS = [
    [".agents/skills", "agents"],
    [".claude/skills", "claude-code"],
    [".cursor/skills", "cursor"],
];
const USER_ROOTS = [
    [".agents/skills", "agents"],
    [".claude/skills", "claude-code"],
    [".cursor/skills", "cursor"],
];
async function exists(candidate) {
    try {
        await access(candidate);
        return true;
    }
    catch {
        return false;
    }
}
function toPortablePath(root, candidate) {
    return path.relative(root, candidate).split(path.sep).join("/").normalize("NFC");
}
function rootsFor(root, scope, home) {
    const roots = [];
    if (scope === "project" || scope === "all") {
        roots.push(...PROJECT_ROOTS.map(([relative, tool]) => ({
            root: path.resolve(root, relative),
            scope: "project",
            tool,
        })));
    }
    if (scope === "user" || scope === "all") {
        roots.push(...USER_ROOTS.map(([relative, tool]) => ({
            root: path.resolve(home, relative),
            scope: "user",
            tool,
        })));
    }
    return roots;
}
export async function discoverSkills(projectRoot, scope = "project", home = os.homedir()) {
    const found = [];
    for (const search of rootsFor(projectRoot, scope, home)) {
        if (!(await exists(search.root)))
            continue;
        const rootMetadata = await lstat(search.root);
        if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory())
            continue;
        const children = await readdir(search.root, { withFileTypes: true });
        children.sort((a, b) => a.name.localeCompare(b.name, "en"));
        for (const child of children) {
            const absolutePath = path.join(search.root, child.name);
            const lockPath = search.scope === "project"
                ? toPortablePath(projectRoot, absolutePath)
                : `~/${toPortablePath(home, absolutePath)}`;
            if (child.isSymbolicLink()) {
                found.push({
                    name: child.name,
                    tool: search.tool,
                    absolutePath,
                    path: lockPath,
                    scope: search.scope,
                    supported: false,
                    reason: "symbolic-link",
                });
                continue;
            }
            if (!child.isDirectory() || !(await exists(path.join(absolutePath, "SKILL.md")))) {
                continue;
            }
            try {
                found.push({
                    name: child.name,
                    tool: search.tool,
                    absolutePath,
                    path: lockPath,
                    scope: search.scope,
                    supported: true,
                    digest: await hashTree(absolutePath),
                });
            }
            catch (error) {
                found.push({
                    name: child.name,
                    tool: search.tool,
                    absolutePath,
                    path: lockPath,
                    scope: search.scope,
                    supported: false,
                    reason: error instanceof Error ? error.message : "hash-failed",
                });
            }
        }
    }
    return found.sort((a, b) => a.path.localeCompare(b.path, "en") || a.tool.localeCompare(b.tool, "en"));
}
//# sourceMappingURL=discovery.js.map