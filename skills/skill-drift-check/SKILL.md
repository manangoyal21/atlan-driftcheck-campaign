---
name: skill-drift-check
description: Verify that shared agent skills match a committed manifest. Use when asked to audit skill locations, create or check skills.lock, detect stale local copies, inspect cache candidates, or preview restoring an immutable Git revision.
compatibility: Requires Node.js 20 or newer. Git is required only for sync.
metadata:
  version: "0.1.0"
---

# Skill Drift Check

## Purpose

Keep shared agent-skill files consistent across repositories, agent-specific
directories, and developer machines. The bundled CLI creates a deterministic
manifest, detects drift without changing files, and can restore a reviewed
Git-pinned version.

Use this skill when:

- a repository keeps the same skill in `.agents`, `.claude`, or other
  supported skill directories;
- teammates need to verify that local copies match the committed version;
- CI should fail when a locked skill is modified or missing;
- onboarding or incident recovery needs a safe, review-first repair path.

Do not use it to claim which skill an agent actually loaded, identify distinct
people, or infer adoption from files found in caches.

## Standard workflow

Run the dependency-free CLI bundled beside this file. Resolve `<skill-dir>` as
the absolute directory containing this `SKILL.md`; do not assume a global
`driftcheck` command and do not run `npm install`.

```text
node "<skill-dir>/runtime/cli.js" audit
```

After the user reviews the discovery result and explicitly approves writing a
manifest:

```text
node "<skill-dir>/runtime/cli.js" lock --root "<project-dir>" --yes
```

Commit `skills.lock`, then have each teammate or CI environment run:

```text
node "<skill-dir>/runtime/cli.js" verify --root "<project-dir>"
```

Exit code `0` means every locked location is OK. Exit code `1` means drift or
policy findings. Use `--format json` for CI and metric calculation.

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

## Metric and expected impact

Primary metric:

```text
skill consistency rate = OK locked locations / all locked locations Ã— 100
```

How the skill improves it:

1. `audit` establishes which supported skill locations exist.
2. `lock` records normalized SHA-256 digests and safe provenance.
3. `verify` classifies each locked location as OK, MODIFIED, MISSING, or
   UNSUPPORTED, making drift visible locally or in CI.
4. `sync` previews a Git-pinned restoration; a post-sync `verify` confirms
   whether consistency returned to 100%.

Useful supporting measures are mismatch count per verification, verification
pass rate, and elapsed time from a failed verification to a passing one. Track
elapsed time in CI or incident tooling because this CLI does not collect
telemetry. Distinct-teammate adoption and business activation remain external
metrics and must not be inferred from local verification alone.