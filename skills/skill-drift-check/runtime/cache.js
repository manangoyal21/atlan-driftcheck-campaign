import { lstat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashTree } from "./hash.js";
const MAX_ROOTS = 8;
const MAX_DEPTH = 10;
const MAX_DIRECTORIES = 5_000;
const MAX_CANDIDATES = 1_000;
function configuredRoots(home) {
    const configured = (variable, fallback, adapter) => {
        const value = process.env[variable];
        const paths = value ? value.split(path.delimiter).filter(Boolean) : [fallback];
        return paths.map((candidate) => ({
            adapter,
            path: path.resolve(candidate),
        }));
    };
    return [
        ...configured("DRIFTCHECK_CLAUDE_CACHE_ROOTS", path.join(home, ".claude", "plugins", "cache"), "claude-code"),
        ...configured("DRIFTCHECK_CODEX_CACHE_ROOTS", path.join(home, ".codex", "plugins", "cache"), "codex"),
    ];
}
async function metadataOrMissing(candidate) {
    try {
        return await lstat(candidate);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
function safeScanRoot(candidate, home) {
    const resolved = path.resolve(candidate);
    const filesystemRoot = path.parse(resolved).root;
    if (resolved === filesystemRoot || resolved === path.resolve(home)) {
        return "Refusing to scan a filesystem or home-directory root";
    }
    return undefined;
}
async function scanRoot(root, lock) {
    const candidates = [];
    let visited = 0;
    const queue = [
        { directory: root.path, depth: 0 },
    ];
    while (queue.length > 0) {
        const current = queue.shift();
        visited += 1;
        if (visited > MAX_DIRECTORIES) {
            candidates.push({
                adapter: root.adapter,
                path: root.path,
                name: "(scan-limit)",
                match: "NONE",
                trackedIdentities: [],
                note: `Candidate scan stopped after ${MAX_DIRECTORIES} directories`,
                supported: false,
            });
            break;
        }
        const children = await readdir(current.directory, { withFileTypes: true });
        const hasSkill = children.some((child) => child.isFile() && child.name === "SKILL.md");
        if (hasSkill) {
            const name = path.basename(current.directory);
            try {
                const digest = await hashTree(current.directory);
                const exact = lock.skills.filter((skill) => skill.digest === digest);
                const sameName = lock.skills.filter((skill) => skill.name === name);
                const matches = exact.length > 0 ? exact : sameName;
                const match = exact.length > 0
                    ? "EXACT_DIGEST"
                    : sameName.length > 0
                        ? "NAME_ONLY"
                        : "NONE";
                candidates.push({
                    adapter: root.adapter,
                    path: current.directory,
                    name,
                    digest,
                    match,
                    trackedIdentities: matches.map((skill) => skill.identity).sort(),
                    note: match === "EXACT_DIGEST"
                        ? "Exact on-disk content candidate; cache presence does not prove runtime loading"
                        : match === "NAME_ONLY"
                            ? "Name-only candidate; shared source is not established and differing content is not drift"
                            : "Unmatched cache candidate; source and runtime use are unknown",
                    supported: true,
                });
            }
            catch (error) {
                candidates.push({
                    adapter: root.adapter,
                    path: current.directory,
                    name,
                    match: "NONE",
                    trackedIdentities: [],
                    note: error instanceof Error ? error.message : String(error),
                    supported: false,
                });
            }
            if (candidates.length >= MAX_CANDIDATES)
                break;
            continue;
        }
        if (current.depth >= MAX_DEPTH)
            continue;
        for (const child of children) {
            if (!child.isDirectory() || child.isSymbolicLink())
                continue;
            queue.push({
                directory: path.join(current.directory, child.name),
                depth: current.depth + 1,
            });
        }
    }
    return candidates;
}
export async function scanCaches(lock, options = {}) {
    const home = path.resolve(options.home ?? os.homedir());
    const roots = options.roots ?? configuredRoots(home);
    const result = { roots: [], candidates: [] };
    if (roots.length > MAX_ROOTS) {
        result.roots.push({
            adapter: roots[0]?.adapter ?? "claude-code",
            path: "(configuration)",
            status: "REFUSED",
            detail: `At most ${MAX_ROOTS} cache roots may be scanned`,
        });
        return result;
    }
    for (const root of roots) {
        const refusal = safeScanRoot(root.path, home);
        if (refusal) {
            result.roots.push({
                adapter: root.adapter,
                path: root.path,
                status: "REFUSED",
                detail: refusal,
            });
            continue;
        }
        const metadata = await metadataOrMissing(root.path);
        if (!metadata) {
            result.roots.push({
                adapter: root.adapter,
                path: root.path,
                status: "MISSING",
            });
            continue;
        }
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            result.roots.push({
                adapter: root.adapter,
                path: root.path,
                status: "REFUSED",
                detail: "Cache root must be a real directory",
            });
            continue;
        }
        result.roots.push({
            adapter: root.adapter,
            path: root.path,
            status: "SCANNED",
        });
        result.candidates.push(...(await scanRoot(root, lock)));
    }
    result.candidates.sort((a, b) => a.adapter.localeCompare(b.adapter, "en") ||
        a.path.localeCompare(b.path, "en"));
    return result;
}
//# sourceMappingURL=cache.js.map