import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { HASH_POLICY, LOCK_FORMAT, LOCK_VERSION, TOOL_NAME, TOOL_VERSION, DriftcheckError, } from "./types.js";
const TOOLS = new Set(["agents", "claude-code", "cursor"]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GIT_REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertString(value, field) {
    if (typeof value !== "string" || value.length === 0) {
        throw new DriftcheckError(`Invalid lockfile field: ${field}`, 2);
    }
}
function assertProjectPath(value, field, allowRoot = false) {
    assertString(value, field);
    const parts = value.split("/");
    if (value.startsWith("/") ||
        /^[A-Za-z]:/.test(value) ||
        value.startsWith("~/") ||
        value.includes("\\") ||
        /[\u0000-\u001f\u007f]/.test(value) ||
        (!allowRoot && value === ".") ||
        (value !== "." && parts.some((part) => part === "" || part === "." || part === ".."))) {
        throw new DriftcheckError(`Invalid project-relative path: ${field}`, 2);
    }
}
function assertTargetPath(tool, value, field) {
    assertProjectPath(value, field);
    const expectedRoot = {
        agents: ".agents/skills/",
        "claude-code": ".claude/skills/",
        cursor: ".cursor/skills/",
    };
    const prefix = expectedRoot[tool];
    if (!value.startsWith(prefix) || value.slice(prefix.length).includes("/")) {
        throw new DriftcheckError(`Sync target must be one direct ${tool} skill directory: ${field}`, 2);
    }
}
export function isSafeGitUrl(value) {
    if (/[\u0000-\u001f\u007f\s]/.test(value))
        return false;
    const scpStyle = /^git@([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):(.+)$/.exec(value);
    if (scpStyle) {
        const remotePath = scpStyle[2];
        return (!remotePath.startsWith("-") &&
            !remotePath.includes("\\") &&
            !remotePath.split("/").includes(".."));
    }
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:")
            return false;
        if (!parsed.hostname || parsed.password || parsed.search || parsed.hash)
            return false;
        if (parsed.protocol === "https:" && parsed.username)
            return false;
        return !decodeURIComponent(parsed.pathname).split("/").includes("..");
    }
    catch {
        return false;
    }
}
function validateSkill(value, index) {
    if (!isRecord(value)) {
        throw new DriftcheckError(`Invalid lockfile skill at index ${index}`, 2);
    }
    assertString(value.identity, `skills[${index}].identity`);
    assertString(value.name, `skills[${index}].name`);
    if (!DIGEST_PATTERN.test(String(value.digest))) {
        throw new DriftcheckError(`Invalid lockfile digest at skills[${index}]`, 2);
    }
    if (!isRecord(value.source)) {
        throw new DriftcheckError(`Invalid source at skills[${index}]`, 2);
    }
    if (value.source.type === "local") {
        assertProjectPath(value.source.path, `skills[${index}].source.path`);
        if (value.syncable !== false) {
            throw new DriftcheckError(`Local source must be non-syncable`, 2);
        }
    }
    else if (value.source.type === "git") {
        assertString(value.source.url, `skills[${index}].source.url`);
        assertString(value.source.revision, `skills[${index}].source.revision`);
        assertProjectPath(value.source.path, `skills[${index}].source.path`, true);
        if (!isSafeGitUrl(value.source.url)) {
            throw new DriftcheckError(`Unsafe Git URL at skills[${index}]`, 2);
        }
        if (!GIT_REVISION_PATTERN.test(value.source.revision)) {
            throw new DriftcheckError(`Git revision must be a full commit ID`, 2);
        }
        if (value.syncable !== true) {
            throw new DriftcheckError(`Git source must be syncable`, 2);
        }
    }
    else {
        throw new DriftcheckError(`Unsupported source at skills[${index}]`, 2);
    }
    if (!Array.isArray(value.targets) || value.targets.length === 0) {
        throw new DriftcheckError(`Missing targets at skills[${index}]`, 2);
    }
    for (const [targetIndex, target] of value.targets.entries()) {
        if (!isRecord(target) || !TOOLS.has(target.tool)) {
            throw new DriftcheckError(`Invalid target at skills[${index}].targets[${targetIndex}]`, 2);
        }
        assertTargetPath(target.tool, target.path, `skills[${index}].targets[${targetIndex}].path`);
    }
}
export function validateLock(value) {
    if (!isRecord(value))
        throw new DriftcheckError("Lockfile must be an object", 2);
    if (value.format !== LOCK_FORMAT || value.version !== LOCK_VERSION) {
        throw new DriftcheckError("Unsupported lockfile format or version", 2);
    }
    if (value.hashPolicy !== HASH_POLICY) {
        throw new DriftcheckError("Unsupported lockfile hash policy", 2);
    }
    if (!isRecord(value.workspace)) {
        throw new DriftcheckError("Invalid lockfile workspace", 2);
    }
    assertString(value.workspace.id, "workspace.id");
    if (!UUID_PATTERN.test(value.workspace.id)) {
        throw new DriftcheckError("Invalid workspace.id UUID", 2);
    }
    assertString(value.workspace.createdAt, "workspace.createdAt");
    if (Number.isNaN(Date.parse(value.workspace.createdAt))) {
        throw new DriftcheckError("Invalid workspace.createdAt timestamp", 2);
    }
    if (!isRecord(value.generatedBy) || value.generatedBy.name !== TOOL_NAME) {
        throw new DriftcheckError("Invalid lockfile generator", 2);
    }
    assertString(value.generatedBy.version, "generatedBy.version");
    if (!Array.isArray(value.skills)) {
        throw new DriftcheckError("Invalid lockfile skills", 2);
    }
    value.skills.forEach(validateSkill);
    const identities = new Set();
    const targets = [];
    for (const skill of value.skills) {
        if (identities.has(skill.identity)) {
            throw new DriftcheckError(`Duplicate skill identity: ${skill.identity}`, 2);
        }
        identities.add(skill.identity);
        for (const target of skill.targets) {
            const portableKey = target.path.normalize("NFC").toLocaleLowerCase("en-US");
            if (targets.some((existing) => existing === portableKey ||
                existing.startsWith(`${portableKey}/`) ||
                portableKey.startsWith(`${existing}/`))) {
                throw new DriftcheckError(`Duplicate or colliding target path: ${target.path}`, 2);
            }
            targets.push(portableKey);
        }
    }
    return value;
}
export async function readLock(lockfilePath) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(lockfilePath, "utf8"));
    }
    catch (error) {
        throw new DriftcheckError(`Unable to read lockfile ${lockfilePath}: ${error instanceof Error ? error.message : String(error)}`, 2);
    }
    return validateLock(parsed);
}
export function createLock(discovered, previous, gitProvenance = new Map()) {
    const workspace = previous?.workspace ?? {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
    };
    const supported = discovered.filter((skill) => skill.scope === "project" && skill.supported && skill.digest);
    const skills = supported.map((skill) => {
        const git = gitProvenance.get(skill.path);
        return {
            identity: git?.identity ?? `workspace:${workspace.id}:${skill.path}`,
            name: skill.name,
            source: git?.source ?? { type: "local", path: skill.path },
            targets: [{ tool: skill.tool, path: skill.path }],
            digest: skill.digest,
            syncable: Boolean(git),
        };
    });
    skills.sort((a, b) => a.identity.localeCompare(b.identity, "en"));
    return {
        format: LOCK_FORMAT,
        version: LOCK_VERSION,
        workspace,
        generatedBy: { name: TOOL_NAME, version: TOOL_VERSION },
        hashPolicy: HASH_POLICY,
        skills,
    };
}
export async function writeLockAtomic(lockfilePath, lock) {
    validateLock(lock);
    await mkdir(path.dirname(lockfilePath), { recursive: true });
    const temporaryPath = `${lockfilePath}.${process.pid}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(lock, null, 2)}\n`;
    try {
        await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
        await rename(temporaryPath, lockfilePath);
    }
    finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
}
export function resolveProjectPath(root, portablePath) {
    if (portablePath.startsWith("/") ||
        /^[A-Za-z]:/.test(portablePath) ||
        portablePath.startsWith("~/")) {
        throw new DriftcheckError(`Lockfile path must be project-relative: ${portablePath}`, 2);
    }
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, ...portablePath.split("/"));
    const relative = path.relative(resolvedRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new DriftcheckError(`Lockfile path escapes project root: ${portablePath}`, 4);
    }
    return resolved;
}
//# sourceMappingURL=lockfile.js.map