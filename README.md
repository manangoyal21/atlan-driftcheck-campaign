# Skill Drift Check

[![skills.sh](https://skills.sh/b/manangoyal21/skill-drift-check)](https://skills.sh/manangoyal21/skill-drift-check)

Local-first verification for shared agent skills. The repository follows the
current Agent Skills convention: one discoverable skill at
`skills/skill-drift-check/SKILL.md`, with its dependency-free Node.js runtime and
schema contained inside that skill directory.

## Purpose

Agent skills are often copied or linked across tools, repositories, and
developer machines. Skill Drift Check creates a deterministic `skills.lock`,
detects missing or modified copies, and safely previews restoration from an
immutable Git revision.

## What it measures

The primary operational metric is:

```text
skill consistency rate = OK locked locations / all locked locations Ã— 100
```

Use `verify --format json` to calculate that rate and track mismatch counts in
CI. A successful repair is demonstrated by a failing verification before sync
and an all-OK verification afterward. The skill does not identify teammates,
prove what an agent loaded, or measure business activation.

## Install

```sh
npx skills add https://github.com/manangoyal21/skill-drift-check --skill skill-drift-check
```

Review the selected agent and scope shown by the installer. The skill invokes
its bundled runtime with Node.js; it does not require or assume a global
`driftcheck` executable.

Requirements: Node.js 20 or newer. Git is needed only for Git-backed sync.

## License

MIT Â© 2026 Manan Goyal.