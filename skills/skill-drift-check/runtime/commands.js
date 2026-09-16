import { access, lstat } from "node:fs/promises";
import path from "node:path";
import { scanCaches, } from "./cache.js";
import { discoverSkills } from "./discovery.js";
import { resolveGitLockProvenance } from "./git.js";
import { hashTree } from "./hash.js";
import { createLock, readLock, resolveProjectPath, writeLockAtomic, } from "./lockfile.js";
import { HASH_POLICY, TOOL_VERSION, DriftcheckError, } from "./types.js";
async function fileExists(candidate) {
    try {
        await access(candidate);
        return true;
    }
    catch {
        return false;
    }
}
export async function auditCommand(root, scope) {
    const skills = await discoverSkills(root, scope);
    const grouped = new Map();
    for (const skill of skills) {
        const existing = grouped.get(skill.name) ?? [];
        existing.push(skill.path);
        grouped.set(skill.name, existing);
    }
    const duplicateCandidates = [...grouped.entries()]
        .filter(([, paths]) => paths.length > 1)
        .map(([name, paths]) => ({ name, paths: [...paths].sort() }))
        .sort((a, b) => a.name.localeCompare(b.name, "en"));
    return {
        command: "audit",
        version: TOOL_VERSION,
        hashPolicy: HASH_POLICY,
        root,
        skills,
        duplicateCandidates,
        summary: {
            discovered: skills.length,
            supported: skills.filter((skill) => skill.supported).length,
            unsupported: skills.filter((skill) => !skill.supported).length,
        },
    };
}
export async function lockCommand(root, lockfilePath, confirmed) {
    if (!confirmed) {
        throw new DriftcheckError("Lock creation requires explicit confirmation with --yes", 4);
    }
    const discovered = await discoverSkills(root, "project");
    const supported = discovered.filter((skill) => skill.supported);
    if (supported.length === 0) {
        throw new DriftcheckError("No supported project skills found; lockfile not written", 1);
    }
    const previous = (await fileExists(lockfilePath))
        ? await readLock(lockfilePath)
        : undefined;
    const provenance = await resolveGitLockProvenance(root, supported);
    const lock = createLock(discovered, previous, provenance.skills);
    await writeLockAtomic(lockfilePath, lock);
    const localReasons = supported
        .filter((skill) => !provenance.skills.has(skill.path))
        .map((skill) => ({
        path: skill.path,
        reason: provenance.localReasons.get(skill.path) ??
            "immutable Git provenance was not established",
    }));
    return {
        command: "lock",
        version: TOOL_VERSION,
        lockfile: lockfilePath,
        workspaceId: lock.workspace.id,
        skills: lock.skills.length,
        gitBacked: lock.skills.filter((skill) => skill.source.type === "git").length,
        localOnly: lock.skills.filter((skill) => skill.source.type === "local").length,
        localReasons,
        unsupported: discovered.length - supported.length,
    };
}
async function verifyTarget(root, identity, name, tool, targetPath, expected) {
    const absolutePath = resolveProjectPath(root, targetPath);
    if (!(await fileExists(absolutePath))) {
        return { identity, name, tool, path: targetPath, status: "MISSING", expected };
    }
    try {
        const metadata = await lstat(absolutePath);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            return {
                identity,
                name,
                tool,
                path: targetPath,
                status: "UNSUPPORTED",
                expected,
                detail: metadata.isSymbolicLink()
                    ? "symbolic-link"
                    : "target-is-not-a-directory",
            };
        }
        const found = await hashTree(absolutePath);
        return {
            identity,
            name,
            tool,
            path: targetPath,
            status: found === expected ? "OK" : "MODIFIED",
            expected,
            found,
        };
    }
    catch (error) {
        return {
            identity,
            name,
            tool,
            path: targetPath,
            status: "UNSUPPORTED",
            expected,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}
export async function verifyCommand(root, lockfilePath, options = {}) {
    const lock = await readLock(lockfilePath);
    const findings = [];
    const trackedPaths = new Set();
    for (const skill of lock.skills) {
        for (const target of skill.targets) {
            trackedPaths.add(target.path);
            findings.push(await verifyTarget(root, skill.identity, skill.name, target.tool, target.path, skill.digest));
        }
    }
    for (const skill of await discoverSkills(root, "project")) {
        if (!trackedPaths.has(skill.path)) {
            findings.push({
                identity: `untracked:${skill.path}`,
                name: skill.name,
                tool: skill.tool,
                path: skill.path,
                status: skill.supported ? "UNTRACKED" : "UNSUPPORTED",
                ...(skill.digest ? { found: skill.digest } : {}),
                ...(skill.reason ? { detail: skill.reason } : {}),
            });
        }
    }
    findings.sort((a, b) => a.path.localeCompare(b.path, "en") ||
        a.identity.localeCompare(b.identity, "en"));
    const summary = {
        OK: 0,
        MODIFIED: 0,
        MISSING: 0,
        UNTRACKED: 0,
        UNSUPPORTED: 0,
    };
    for (const finding of findings)
        summary[finding.status] += 1;
    const cacheScan = options.scanCaches
        ? await scanCaches(lock, options.cacheOptions)
        : undefined;
    return {
        command: "verify",
        version: TOOL_VERSION,
        lockfile: path.resolve(lockfilePath),
        findings,
        summary,
        ...(cacheScan ? { cacheScan } : {}),
    };
}
//# sourceMappingURL=commands.js.map