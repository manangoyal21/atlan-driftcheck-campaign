# Skill Drift Check

[![skills.sh](https://skills.sh/b/manangoyal21/skill-drift-check)](https://skills.sh/manangoyal21/skill-drift-check)

Local-first verification for shared agent skills. The repository follows the
current Agent Skills convention: one discoverable skill at
`skills/skill-drift-check/SKILL.md`, with its dependency-free Node.js runtime and
schema contained inside that skill directory.

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