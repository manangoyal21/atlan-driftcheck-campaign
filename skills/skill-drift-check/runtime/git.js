import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashTree } from "./hash.js";
import { isSafeGitUrl } from "./lockfile.js";
import { DriftcheckError } from "./types.js";
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TREE_BYTES = 25 * 1024 * 1024;
const SAFE_MODES = new Set(["100644", "100755"]);
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
function gitEnvironment() {
    const environment = {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
    };
    delete environment.GIT_SSH;
    delete environment.GIT_SSH_COMMAND;
    for (const key of Object.keys(environment)) {
        if (key === "GIT_CONFIG_COUNT" ||
            key.startsWith("GIT_CONFIG_KEY_") ||
            key.startsWith("GIT_CONFIG_VALUE_")) {
            delete environment[key];
        }
    }
    return environment;
}
function sanitizeGitError(stderr) {
    const text = stderr.toString("utf8").trim();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
async function runGit(repository, arguments_) {
    const hookDirectory = await mkdtemp(path.join(os.tmpdir(), "driftcheck-hooks-"));
    const argumentsWithSafety = [
        ...(repository ? ["-C", repository] : []),
        "-c",
        `core.hooksPath=${hookDirectory}`,
        "-c",
        "protocol.file.allow=never",
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "core.sshCommand=ssh",
        ...arguments_,
    ];
    try {
        return await new Promise((resolve, reject) => {
            const child = spawn("git", argumentsWithSafety, {
                shell: false,
                windowsHide: true,
                env: gitEnvironment(),
                stdio: ["ignore", "pipe", "pipe"],
            });
            const stdout = [];
            const stderr = [];
            let bytes = 0;
            let settled = false;
            const fail = (error) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeout);
                child.kill();
                reject(error);
            };
            const timeout = setTimeout(() => fail(new DriftcheckError("Git command timed out after 60 seconds", 3)), 60_000);
            timeout.unref();
            const collect = (target, chunk) => {
                bytes += chunk.length;
                if (bytes > MAX_GIT_OUTPUT) {
                    fail(new DriftcheckError("Git output exceeded safety limit", 4));
                    return;
                }
                target.push(chunk);
            };
            child.stdout.on("data", (chunk) => collect(stdout, chunk));
            child.stderr.on("data", (chunk) => collect(stderr, chunk));
            child.on("error", (error) => fail(new DriftcheckError(`Unable to execute Git: ${error.message}`, 3)));
            child.on("close", (code) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeout);
                const result = {
                    stdout: Buffer.concat(stdout),
                    stderr: Buffer.concat(stderr),
                };
                if (code === 0) {
                    resolve(result);
                }
                else {
                    reject(new DriftcheckError(`Git command failed${sanitizeGitError(result.stderr) ? `: ${sanitizeGitError(result.stderr)}` : ""}`, 3));
                }
            });
        });
    }
    finally {
        await rm(hookDirectory, { recursive: true, force: true });
    }
}
async function tryGitText(repository, arguments_) {
    try {
        const value = (await runGit(repository, arguments_)).stdout
            .toString("utf8")
            .trim();
        return value || undefined;
    }
    catch {
        return undefined;
    }
}
async function detectGitRepository(projectRoot) {
    const repositoryRootText = await tryGitText(projectRoot, [
        "rev-parse",
        "--show-toplevel",
    ]);
    if (!repositoryRootText)
        return { reason: "not inside a Git worktree" };
    const repositoryRoot = path.resolve(repositoryRootText);
    const revision = await tryGitText(repositoryRoot, [
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
    ]);
    if (!revision || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision)) {
        return { reason: "repository has no full committed HEAD revision" };
    }
    const branch = await tryGitText(repositoryRoot, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
    ]);
    if (!branch) {
        return { reason: "detached HEAD has no verifiable upstream branch" };
    }
    const remoteName = await tryGitText(repositoryRoot, [
        "config",
        "--get",
        `branch.${branch}.remote`,
    ]);
    if (!remoteName || remoteName === ".") {
        return { reason: "current branch has no remote upstream" };
    }
    const upstreamRevision = await tryGitText(repositoryRoot, [
        "rev-parse",
        "--verify",
        "@{upstream}^{commit}",
    ]);
    if (!upstreamRevision || upstreamRevision.toLowerCase() !== revision.toLowerCase()) {
        return { reason: "HEAD is not equal to its recorded upstream revision" };
    }
    const remoteUrl = await tryGitText(repositoryRoot, [
        "config",
        "--get",
        `remote.${remoteName}.url`,
    ]);
    if (!remoteUrl)
        return { reason: "upstream remote has no URL" };
    if (!isSafeGitUrl(remoteUrl)) {
        return {
            reason: "upstream remote URL is unsupported or contains embedded credentials",
        };
    }
    return {
        repository: {
            repositoryRoot,
            remoteUrl,
            revision: revision.toLowerCase(),
        },
    };
}
function portableRelativePath(root, candidate) {
    const relative = path.relative(root, candidate);
    if (relative.length === 0 ||
        relative.startsWith("..") ||
        path.isAbsolute(relative)) {
        return undefined;
    }
    return relative.split(path.sep).join("/").normalize("NFC");
}
export async function resolveGitLockProvenance(projectRoot, skills) {
    const result = {
        skills: new Map(),
        localReasons: new Map(),
    };
    const detected = await detectGitRepository(projectRoot);
    if ("reason" in detected) {
        for (const skill of skills)
            result.localReasons.set(skill.path, detected.reason);
        return result;
    }
    result.repository = detected.repository;
    for (const skill of skills) {
        const sourcePath = portableRelativePath(detected.repository.repositoryRoot, skill.absolutePath);
        if (!sourcePath || !skill.digest) {
            result.localReasons.set(skill.path, "skill is outside the repository or has no supported digest");
            continue;
        }
        const status = await runGit(detected.repository.repositoryRoot, [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--",
            sourcePath,
        ]);
        if (status.stdout.length > 0) {
            result.localReasons.set(skill.path, "skill has staged, unstaged, or untracked content");
            continue;
        }
        const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "driftcheck-lock-source-"));
        const materialized = path.join(temporaryRoot, "skill");
        try {
            await materializeGitTree(detected.repository.repositoryRoot, detected.repository.revision, sourcePath, materialized);
            const committedDigest = await hashTree(materialized);
            if (committedDigest !== skill.digest) {
                result.localReasons.set(skill.path, "working content differs from the committed Git subtree");
                continue;
            }
            const source = {
                type: "git",
                url: detected.repository.remoteUrl,
                revision: detected.repository.revision,
                path: sourcePath,
            };
            result.skills.set(skill.path, {
                source,
                identity: `git:${detected.repository.remoteUrl}//${sourcePath}`,
            });
        }
        catch {
            result.localReasons.set(skill.path, "committed Git subtree is unsupported for safe object extraction");
        }
        finally {
            await rm(temporaryRoot, { recursive: true, force: true });
        }
    }
    return result;
}
function validateTreePath(candidate) {
    if (candidate.length === 0 ||
        candidate.startsWith("/") ||
        candidate.includes("\\") ||
        candidate.includes("\0") ||
        candidate.split("/").some((part) => part === "" || part === "." || part === "..")) {
        throw new DriftcheckError(`Unsafe Git tree path: ${JSON.stringify(candidate)}`, 4);
    }
    const normalized = candidate.normalize("NFC");
    if (normalized !== candidate) {
        throw new DriftcheckError(`Git tree path is not Unicode NFC: ${JSON.stringify(candidate)}`, 4);
    }
    return normalized;
}
function parseTree(output) {
    const records = [];
    let start = 0;
    for (let index = 0; index < output.length; index += 1) {
        if (output[index] === 0) {
            if (index > start)
                records.push(output.subarray(start, index));
            start = index + 1;
        }
    }
    if (start !== output.length) {
        throw new DriftcheckError("Malformed non-terminated Git tree output", 4);
    }
    if (records.length > MAX_FILES) {
        throw new DriftcheckError(`Git subtree exceeds ${MAX_FILES} files`, 4);
    }
    const portablePaths = new Map();
    return records.map((record) => {
        const tab = record.indexOf(9);
        const metadata = tab >= 0 ? record.subarray(0, tab).toString("ascii") : "";
        let entryPath = "";
        try {
            entryPath =
                tab >= 0 ? fatalUtf8Decoder.decode(record.subarray(tab + 1)) : "";
        }
        catch {
            throw new DriftcheckError("Git tree path is not valid UTF-8", 4);
        }
        const [mode, type, object, extra] = metadata.split(" ");
        if (!mode || !type || !object || extra) {
            throw new DriftcheckError("Malformed Git tree entry", 4);
        }
        const safePath = validateTreePath(entryPath);
        const portableKey = safePath.toLocaleLowerCase("en-US");
        const collision = portablePaths.get(portableKey);
        if (collision && collision !== safePath) {
            throw new DriftcheckError(`Non-portable Git path collision: ${collision} and ${safePath}`, 4);
        }
        portablePaths.set(portableKey, safePath);
        if (type !== "blob" || !SAFE_MODES.has(mode)) {
            const kind = mode === "120000" ? "symbolic link" : type === "commit" ? "submodule" : `${type} ${mode}`;
            throw new DriftcheckError(`Unsupported ${kind} in Git subtree: ${safePath}`, 4);
        }
        return { mode, type, object, path: safePath };
    });
}
async function assertDirectory(candidate) {
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new DriftcheckError(`Git repository is not a safe directory: ${candidate}`, 4);
    }
}
export async function materializeGitTree(repository, revision, sourcePath, destination) {
    await assertDirectory(repository);
    const objectExpression = `${revision}:${sourcePath}`;
    const objectType = (await runGit(repository, ["cat-file", "-t", objectExpression])).stdout
        .toString("ascii")
        .trim();
    if (objectType !== "tree") {
        throw new DriftcheckError(`Git source subtree is not a directory: ${sourcePath}`, 4);
    }
    const tree = parseTree((await runGit(repository, ["ls-tree", "-r", "-z", objectExpression])).stdout);
    if (!tree.some((entry) => entry.path === "SKILL.md")) {
        throw new DriftcheckError(`Git source subtree does not contain a root SKILL.md: ${sourcePath}`, 4);
    }
    let totalBytes = 0;
    const blobs = [];
    for (const entry of tree) {
        const sizeText = (await runGit(repository, ["cat-file", "-s", entry.object])).stdout
            .toString("ascii")
            .trim();
        const size = Number(sizeText);
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
            throw new DriftcheckError(`Git blob exceeds ${MAX_FILE_BYTES} bytes: ${entry.path}`, 4);
        }
        totalBytes += size;
        if (totalBytes > MAX_TREE_BYTES) {
            throw new DriftcheckError(`Git subtree exceeds ${MAX_TREE_BYTES} bytes`, 4);
        }
        const bytes = (await runGit(repository, ["cat-file", "blob", entry.object])).stdout;
        if (bytes
            .subarray(0, 100)
            .toString("ascii")
            .startsWith("version https://git-lfs.github.com/spec/v1")) {
            throw new DriftcheckError(`Git LFS pointer is unsupported: ${entry.path}`, 4);
        }
        blobs.push({ ...entry, bytes });
    }
    await mkdir(destination, { recursive: false });
    for (const entry of blobs) {
        const outputPath = path.resolve(destination, ...entry.path.split("/"));
        const relative = path.relative(destination, outputPath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new DriftcheckError(`Git path escapes staging directory: ${entry.path}`, 4);
        }
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, entry.bytes, { flag: "wx" });
    }
}
export async function fetchAndMaterializeGitSource(source, destination) {
    const repository = await mkdtemp(path.join(os.tmpdir(), "driftcheck-git-"));
    try {
        await runGit(undefined, ["init", "--bare", repository]);
        await runGit(repository, [
            "fetch",
            "--no-tags",
            "--depth=1",
            source.url,
            source.revision,
        ]);
        const fetchedRevision = (await runGit(repository, ["rev-parse", "FETCH_HEAD^{commit}"])).stdout
            .toString("ascii")
            .trim()
            .toLowerCase();
        if (fetchedRevision !== source.revision.toLowerCase()) {
            throw new DriftcheckError(`Fetched commit ${fetchedRevision} does not match locked revision ${source.revision}`, 4);
        }
        await materializeGitTree(repository, source.revision, source.path, destination);
    }
    finally {
        await rm(repository, { recursive: true, force: true });
    }
}
//# sourceMappingURL=git.js.map