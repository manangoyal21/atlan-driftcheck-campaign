#!/usr/bin/env node
import path from "node:path";
import { auditCommand, lockCommand, verifyCommand } from "./commands.js";
import { syncCommand } from "./sync.js";
import { TOOL_VERSION, DriftcheckError, } from "./types.js";
const HELP = `driftcheck ${TOOL_VERSION}

Usage:
  driftcheck audit [--scope project|user|all] [--root PATH] [--format text|json]
  driftcheck lock --yes [--root PATH] [--lockfile PATH] [--format text|json]
  driftcheck verify [--scan-caches] [--root PATH] [--lockfile PATH] [--format text|json]
  driftcheck sync [--skill ID] [--preview]
  driftcheck sync --apply --yes [--skill ID]

Exit codes:
  0 healthy/successful
  1 drift or policy findings
  2 invalid arguments, configuration, or lockfile
  3 filesystem or operational failure
  4 operation refused or unsupported

Not implemented in this milestone:
  receipts and verify --agent
`;
function optionValue(args, name) {
    const index = args.indexOf(name);
    if (index < 0)
        return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
        throw new DriftcheckError(`Missing value for ${name}`, 2);
    }
    return value;
}
function parseArgs(argv) {
    if (argv.includes("--help") || argv.includes("-h")) {
        process.stdout.write(HELP);
        process.exit(0);
    }
    if (argv.includes("--version")) {
        process.stdout.write(`${TOOL_VERSION}\n`);
        process.exit(0);
    }
    const command = argv[0] ?? "";
    if (!["audit", "lock", "verify", "sync"].includes(command)) {
        throw new DriftcheckError(`Unknown or missing command: ${command || "(none)"}`, 2);
    }
    const valueOptions = new Set([
        "--root",
        "--lockfile",
        "--format",
        "--scope",
        "--receipt",
        "--skill",
    ]);
    const booleanOptions = new Set([
        "--yes",
        "--apply",
        "--preview",
        "--scan-caches",
        "--agent",
    ]);
    for (let index = 1; index < argv.length; index += 1) {
        const argument = argv[index];
        if (valueOptions.has(argument)) {
            index += 1;
            continue;
        }
        if (booleanOptions.has(argument))
            continue;
        throw new DriftcheckError(`Unknown argument: ${argument}`, 2);
    }
    const root = path.resolve(optionValue(argv, "--root") ?? process.cwd());
    const lockfileOption = optionValue(argv, "--lockfile") ?? "skills.lock";
    const lockfile = path.isAbsolute(lockfileOption)
        ? lockfileOption
        : path.resolve(root, lockfileOption);
    const format = (optionValue(argv, "--format") ?? "text");
    if (!["text", "json"].includes(format)) {
        throw new DriftcheckError(`Invalid --format: ${format}`, 2);
    }
    const scope = (optionValue(argv, "--scope") ?? "project");
    if (!["project", "user", "all"].includes(scope)) {
        throw new DriftcheckError(`Invalid --scope: ${scope}`, 2);
    }
    const identity = optionValue(argv, "--skill");
    return {
        command,
        root,
        lockfile,
        format,
        scope,
        yes: argv.includes("--yes"),
        apply: argv.includes("--apply"),
        ...(identity ? { identity } : {}),
        flags: new Set(argv.filter((arg) => arg.startsWith("--"))),
    };
}
function shortDigest(digest) {
    return digest ? `${digest.slice(0, 19)}…` : "-";
}
function renderText(result) {
    if (!result || typeof result !== "object" || !("command" in result)) {
        return `${String(result)}\n`;
    }
    const value = result;
    if (value.command === "audit") {
        const skills = value.skills;
        const lines = skills.map((skill) => `${skill.supported ? "FOUND" : "UNSUPPORTED"}  ${String(skill.tool).padEnd(11)} ${skill.path} ${shortDigest(skill.digest)}`);
        const summary = value.summary;
        lines.push("", `${summary.discovered} discovered; ${summary.supported} supported; ${summary.unsupported} unsupported.`);
        const duplicates = value.duplicateCandidates;
        if (duplicates.length > 0) {
            lines.push(`${duplicates.length} same-name duplicate candidate(s); shared provenance is not inferred.`);
        }
        return `${lines.join("\n")}\n`;
    }
    if (value.command === "lock") {
        const localReasons = value.localReasons;
        const lines = [
            `LOCKED     ${value.skills} skill(s) in ${value.lockfile}`,
            `Git-backed: ${value.gitBacked}; local non-syncable: ${value.localOnly}`,
            `Workspace: ${value.workspaceId}`,
            `Unsupported discoveries: ${value.unsupported}`,
        ];
        for (const local of localReasons) {
            lines.push(`LOCAL      ${local.path} — ${local.reason}`);
        }
        return `${lines.join("\n")}\n`;
    }
    if (value.command === "verify") {
        const findings = value.findings;
        const lines = findings.map((finding) => {
            const details = finding.status === "MODIFIED"
                ? ` expected ${shortDigest(finding.expected)} found ${shortDigest(finding.found)}`
                : finding.detail
                    ? ` ${finding.detail}`
                    : "";
            return `${String(finding.status).padEnd(11)} ${finding.path}${details}`;
        });
        const summary = value.summary;
        lines.push("", `OK ${summary.OK}; MODIFIED ${summary.MODIFIED}; MISSING ${summary.MISSING}; UNTRACKED ${summary.UNTRACKED}; UNSUPPORTED ${summary.UNSUPPORTED}.`);
        const cacheScan = value.cacheScan;
        if (cacheScan) {
            lines.push("", "Cache candidates (read-only; presence does not prove loading):");
            for (const candidate of cacheScan.candidates) {
                lines.push(`${String(candidate.match).padEnd(12)} ${candidate.adapter} ${candidate.path} — ${candidate.note}`);
            }
            const roots = cacheScan.roots
                .map((root) => `${root.adapter}:${root.status}`)
                .join(", ");
            lines.push(`Roots: ${roots || "none"}`);
        }
        return `${lines.join("\n")}\n`;
    }
    if (value.command === "sync") {
        const findings = value.findings;
        const lines = findings.map((finding) => {
            const backup = finding.backup ? ` backup ${finding.backup}` : "";
            return `${String(finding.action).padEnd(10)} ${finding.target}${backup}`;
        });
        lines.push("", `${value.mode === "preview" ? "Preview only" : `${value.applied} target(s) applied`}.`);
        if (value.mode === "preview" && findings.some((finding) => finding.action !== "NO_CHANGE")) {
            lines.push("Run again with --apply --yes to install these exact verified contents.");
        }
        return `${lines.join("\n")}\n`;
    }
    return `${JSON.stringify(result, null, 2)}\n`;
}
function render(format, result) {
    process.stdout.write(format === "json" ? `${JSON.stringify(result, null, 2)}\n` : renderText(result));
}
function rejectUnsupported(options) {
    const unsupported = ["--receipt", "--agent"].filter((flag) => options.flags.has(flag));
    if (unsupported.length > 0) {
        throw new DriftcheckError(`Unsupported in this milestone: ${unsupported.join(", ")}`, 4);
    }
    if (options.flags.has("--scan-caches") && options.command !== "verify") {
        throw new DriftcheckError("--scan-caches is supported only by verify", 2);
    }
}
async function run() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
        rejectUnsupported(options);
        if (options.command === "audit") {
            const result = await auditCommand(options.root, options.scope);
            render(options.format, result);
            return result.summary.unsupported > 0 ? 1 : 0;
        }
        if (options.command === "lock") {
            const result = await lockCommand(options.root, options.lockfile, options.yes);
            render(options.format, result);
            return result.unsupported > 0 || result.localOnly > 0 ? 1 : 0;
        }
        if (options.command === "sync") {
            if (options.flags.has("--preview") && options.apply) {
                throw new DriftcheckError("--preview and --apply cannot be combined", 2);
            }
            const result = await syncCommand(options.root, options.lockfile, {
                apply: options.apply,
                yes: options.yes,
                ...(options.identity ? { identity: options.identity } : {}),
            });
            render(options.format, result);
            return 0;
        }
        const result = await verifyCommand(options.root, options.lockfile, {
            scanCaches: options.flags.has("--scan-caches"),
        });
        render(options.format, result);
        const localFinding = Object.entries(result.summary).some(([status, count]) => status !== "OK" && count > 0);
        const cacheFinding = result.cacheScan?.roots.some((root) => root.status === "REFUSED") ||
            result.cacheScan?.candidates.some((candidate) => !candidate.supported) ||
            false;
        return localFinding || cacheFinding ? 1 : 0;
    }
    catch (error) {
        const exitCode = error instanceof DriftcheckError ? error.exitCode : 3;
        const message = error instanceof Error ? error.message : String(error);
        if (options?.format === "json") {
            process.stderr.write(`${JSON.stringify({ error: { message, exitCode } }, null, 2)}\n`);
        }
        else {
            process.stderr.write(`ERROR ${message}\n`);
        }
        return exitCode;
    }
}
process.exitCode = await run();
//# sourceMappingURL=cli.js.map