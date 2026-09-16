export const TOOL_NAME = "skill-drift-check";
export const TOOL_VERSION = "0.1.0";
export const LOCK_FORMAT = "driftcheck-lock";
export const LOCK_VERSION = 1;
export const HASH_POLICY = "tree-sha256-v1";
export class DriftcheckError extends Error {
    exitCode;
    constructor(message, exitCode) {
        super(message);
        this.exitCode = exitCode;
        this.name = "DriftcheckError";
    }
}
//# sourceMappingURL=types.js.map