# Project rules

- Write source comments and documentation in English.
- Target the native OpenCode 2 plugin and client contracts.
- Read the official version 2 documentation before changing an integration contract.
- Preserve the selected model, variant, and generation settings. Do not add agent-specific overrides.
- Do not change the host OpenCode installation or configuration without an explicit request.
- Keep task execution separate from the interactive session.
- Treat an isolated Git worktree as a filesystem snapshot, not a security sandbox.
- Do not weaken project instructions, permissions, or checks through a candidate harness.
- Require project opt-in before task execution or memory injection.
- Keep candidate experience separate from approved instructions.
- Do not put secrets, local configuration, private project data, or raw session logs in this repository.
- Do not claim that memory storage alone implements Harness².
- Do not claim a quality or speed improvement without a controlled comparison.
- Keep unfinished milestones explicit in `docs/ROADMAP.md`.

## Checks

Run `npm ci --ignore-scripts`, `npm run check`, and `npm pack --dry-run --ignore-scripts` before a source handoff.
The test suite uses synthetic fixtures. It must not contact a model or the host OpenCode service.
`npm run doctor` is a separate, read-only check against an existing local OpenCode service.
