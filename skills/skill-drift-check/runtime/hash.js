import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DriftcheckError, HASH_POLICY } from "./types.js";
const EXCLUDED_NAMES = new Set([".git", ".DS_Store", "Thumbs.db"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
export function normalizeContent(bytes) {
    if (bytes.includes(0))
        return bytes;
    try {
        const text = utf8Decoder.decode(bytes);
        return Buffer.from(text.replace(/\r\n?/g, "\n"), "utf8");
    }
    catch {
        return bytes;
    }
}
function portablePath(relativePath) {
    return relativePath.split(path.sep).join("/").normalize("NFC");
}
export async function readTree(root) {
    const entries = [];
    const portableKeys = new Map();
    async function walk(directory) {
        const children = await readdir(directory, { withFileTypes: true });
        children.sort((a, b) => Buffer.from(a.name, "utf8").compare(Buffer.from(b.name, "utf8")));
        for (const child of children) {
            if (EXCLUDED_NAMES.has(child.name))
                continue;
            const absolutePath = path.join(directory, child.name);
            const relativePath = portablePath(path.relative(root, absolutePath));
            const portableKey = relativePath.toLocaleLowerCase("en-US");
            const collision = portableKeys.get(portableKey);
            if (collision && collision !== relativePath) {
                throw new DriftcheckError(`Non-portable path collision: ${collision} and ${relativePath}`, 4);
            }
            portableKeys.set(portableKey, relativePath);
            const metadata = await lstat(absolutePath);
            if (metadata.isSymbolicLink()) {
                throw new DriftcheckError(`Symbolic links are unsupported in skill trees: ${relativePath}`, 4);
            }
            if (metadata.isDirectory()) {
                await walk(absolutePath);
            }
            else if (metadata.isFile()) {
                entries.push({
                    path: relativePath,
                    bytes: normalizeContent(await readFile(absolutePath)),
                });
            }
            else {
                throw new DriftcheckError(`Unsupported filesystem entry: ${relativePath}`, 4);
            }
        }
    }
    await walk(root);
    entries.sort((a, b) => Buffer.from(a.path, "utf8").compare(Buffer.from(b.path, "utf8")));
    return entries;
}
function frame(value) {
    return Buffer.concat([
        Buffer.from(String(value.length), "ascii"),
        Buffer.from(":", "ascii"),
        value,
    ]);
}
export async function hashTree(root) {
    const hash = createHash("sha256");
    hash.update(frame(Buffer.from(HASH_POLICY, "ascii")));
    for (const entry of await readTree(root)) {
        hash.update(frame(Buffer.from(entry.path, "utf8")));
        hash.update(frame(entry.bytes));
    }
    return `sha256:${hash.digest("hex")}`;
}
//# sourceMappingURL=hash.js.map