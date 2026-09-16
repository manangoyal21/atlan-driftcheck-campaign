import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, rename, rm, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fetchAndMaterializeGitSource } from "./git.js";
import { hashTree } from "./hash.js";
import { readLock, resolveProjectPath } from "./lockfile.js";
import { TOOL_VERSION, DriftcheckError } from "./types.js";
const defaultDependencies = {
    materializeSource: fetchAndMaterializeGitSource,
};
async function pathExists(candidate) {
    try {
        await lstat(candidate);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
async function assertSafeDestination(root, portableTarget) {
    const destination = resolveProjectPath(root, portableTarget);
    const resolvedRoot = path.resolve(root);
    const rootMetadata = await lstat(resolvedRoot);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
        throw new DriftcheckError("Project root must be a real directory", 4);
    }
    const relative = path.relative(resolvedRoot, destination);
    let cursor = resolvedRoot;
    for (const part of relative.split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        try {
            const metadata = await lstat(cursor);
            if (metadata.isSymbolicLink()) {
                throw new DriftcheckError(`Destination path crosses a symbolic link: ${portableTarget}`, 4);
            }
            if (cursor !== destination && !metadata.isDirectory()) {
                throw new DriftcheckError(`Destination parent is not a directory: ${portableTarget}`, 4);
            }
            if (cursor === destination && !metadata.isDirectory()) {
                throw new DriftcheckError(`Destination is not a directory: ${portableTarget}`, 4);
            }
        }
        catch (error) {
            if (error.code === "ENOENT")
                break;
            throw error;
        }
    }
    return destination;
}
async function ensureInternalStorage(root, kind) {
    const resolvedRoot = path.resolve(root);
    let cursor = resolvedRoot;
    for (const part of [".driftcheck", kind]) {
        cursor = path.join(cursor, part);
        try {
            const metadata = await lstat(cursor);
            if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
                throw new DriftcheckError(`Internal ${kind} storage must be a real directory`, 4);
            }
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            await mkdir(cursor);
        }
    }
    return cursor;
}
function asGitSkill(skill) {
    if (skill.source.type !== "git" || !skill.syncable) {
        throw new DriftcheckError(`Skill is not safely syncable from immutable Git: ${skill.identity}`, 4);
    }
    return skill;
}
async function prepare(root, lockfilePath, options, dependencies, temporaryRoot) {
    const lock = await readLock(lockfilePath);
    const selected = options.identity
        ? lock.skills.filter((skill) => skill.identity === options.identity)
        : lock.skills;
    if (options.identity && selected.length === 0) {
        throw new DriftcheckError(`Unknown skill identity: ${options.identity}`, 2);
    }
    if (selected.length === 0) {
        throw new DriftcheckError("Lockfile contains no skills to sync", 4);
    }
    const prepared = [];
    for (const [skillIndex, candidate] of selected.entries()) {
        const skill = asGitSkill(candidate);
        const materialized = path.join(temporaryRoot, `source-${skillIndex}`);
        await dependencies.materializeSource(skill.source, materialized);
        const fetchedDigest = await hashTree(materialized);
        if (fetchedDigest !== skill.digest) {
            throw new DriftcheckError(`Fetched digest mismatch for ${skill.identity}: expected ${skill.digest}, found ${fetchedDigest}`, 4);
        }
        for (const target of skill.targets) {
            const destination = await assertSafeDestination(root, target.path);
            let current;
            let action = "CREATE";
            if (await pathExists(destination)) {
                current = await hashTree(destination);
                action = current === skill.digest ? "NO_CHANGE" : "REPLACE";
            }
            prepared.push({
                skill,
                targetPath: target.path,
                destination,
                materialized,
                finding: {
                    identity: skill.identity,
                    name: skill.name,
                    target: target.path,
                    source: { ...skill.source },
                    action,
                    expected: skill.digest,
                    ...(current ? { current } : {}),
                },
            });
        }
    }
    return prepared;
}
async function rollback(applied) {
    for (const item of [...applied].reverse()) {
        await rm(item.destination, { recursive: true, force: true });
        if (item.backup) {
            await rename(item.backup, item.destination);
        }
    }
}
async function applyPrepared(root, prepared) {
    const applied = [];
    const actionable = prepared.some((item) => item.finding.action !== "NO_CHANGE");
    const stagingRoot = actionable
        ? await ensureInternalStorage(root, "staging")
        : undefined;
    const backupRoot = actionable
        ? await ensureInternalStorage(root, "backups")
        : undefined;
    try {
        for (const item of prepared) {
            if (item.finding.action === "NO_CHANGE")
                continue;
            await assertSafeDestination(root, item.targetPath);
            const parent = path.dirname(item.destination);
            await mkdir(parent, { recursive: true });
            await assertSafeDestination(root, item.targetPath);
            const stage = path.join(stagingRoot, `.driftcheck-stage-${path.basename(item.destination)}-${randomUUID()}`);
            try {
                await cp(item.materialized, stage, {
                    recursive: true,
                    force: false,
                    errorOnExist: true,
                });
                if ((await hashTree(stage)) !== item.skill.digest) {
                    throw new DriftcheckError(`Staged digest changed for ${item.skill.identity}`, 4);
                }
                await assertSafeDestination(root, item.targetPath);
                let backup;
                if (await pathExists(item.destination)) {
                    backup = path.join(backupRoot, `.driftcheck-backup-${path.basename(item.destination)}-${new Date()
                        .toISOString()
                        .replace(/[:.]/g, "-")}-${randomUUID()}`);
                    await rename(item.destination, backup);
                }
                try {
                    await rename(stage, item.destination);
                }
                catch (error) {
                    if (backup)
                        await rename(backup, item.destination);
                    throw error;
                }
                applied.push({ destination: item.destination, ...(backup ? { backup } : {}) });
                if (backup)
                    item.finding.backup = backup;
            }
            finally {
                await rm(stage, { recursive: true, force: true });
            }
        }
        return applied.length;
    }
    catch (error) {
        try {
            await rollback(applied);
        }
        catch (rollbackError) {
            throw new DriftcheckError(`Sync failed and rollback was incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, 3);
        }
        throw error;
    }
}
export async function syncCommand(root, lockfilePath, options, dependencies = defaultDependencies) {
    if (options.apply !== options.yes) {
        throw new DriftcheckError("Applying sync requires both --apply and --yes; omit both for preview", 4);
    }
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "driftcheck-sync-"));
    try {
        const prepared = await prepare(root, lockfilePath, options, dependencies, temporaryRoot);
        const applied = options.apply ? await applyPrepared(root, prepared) : 0;
        return {
            command: "sync",
            version: TOOL_VERSION,
            mode: options.apply ? "apply" : "preview",
            lockfile: path.resolve(lockfilePath),
            findings: prepared.map((item) => item.finding),
            applied,
        };
    }
    finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
}
//# sourceMappingURL=sync.js.map