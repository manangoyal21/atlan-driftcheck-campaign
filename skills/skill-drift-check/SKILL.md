---
name: skill-drift-check
description: Verify that shared agent skills match a committed manifest. Use when asked to audit skill locations, create or check skills.lock, detect stale local copies, inspect cache candidates, or preview restoring an immutable Git revision.
compatibility: Requires Node.js 20 or newer. Git is required only for sync.
metadata:
  version: "0.1.0"
---

# Skill Drift Check

Run the dependency-free CLI bundled beside this file. Resolve `<skill-dir>` as
the absolute directory containing this `SKILL.md`; do not assume a global
`driftcheck` command and do not run `npm install`.

```text
node "<skill-dir>/runtime/cli.js" audit
node "<skill-dir>/runtime/cli.js" verify
```

Pass the user's project explicitly when it is not the current working directory:

```text
node "<skill-dir>/runtime/cli.js" audit --root "<project-dir>"
node "<skill-dir>/runtime/cli.js" verify --root "<project-dir>"
```

Cache inspection is explicit and read-only:

```text
node "<skill-dir>/runtime/cli.js" verify --root "<project-dir>" --scan-caches
```

Describe cache results only as candidates. Cache presence does not prove what
an agent loaded, and same-name content does not establish shared provenance.

Git-backed synchronization previews by default:

```text
node "<skill-dir>/runtime/cli.js" sync --root "<project-dir>"
```

Only after the user reviews the preview may they explicitly request:

```text
node "<skill-dir>/runtime/cli.js" sync --root "<project-dir>" --apply --yes
```

Never add `--apply` or `--yes` on the user's behalf. Never delete cache entries.
Receipts and running-agent revision checks are unsupported.