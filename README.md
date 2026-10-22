# opencode-harness2

An independent OpenCode 2 plugin project for an integration with
[Harness²](https://github.com/google-research/harness2).

**Status: foundation only.** This project does not yet run the Harness² improvement cycle or provide persistent memory.
It does not claim a quality or speed improvement. It is not an official Google or OpenCode product.

## Goal

Keep the normal `opencode` workflow. Add project-scoped experience and an explicit improvement command through a native version 2 plugin.
Reuse the Harness² improvement method instead of calling ordinary memory storage a Harness² integration.

See the [implementation plan](docs/ROADMAP.md) for milestones and acceptance criteria.

## Current scope

- A native version 2 plugin with status, opt-in, cancel, and approval-gated memory controls.
- An isolated OpenCode 2 session runner and a bridge to the upstream Harness² cycle.
- A client connection check for an existing local OpenCode 2 service.
- Offline contract tests and a continuous integration workflow.

The plugin does not install itself. A project stays disabled until explicit opt-in.
A passing offline check does not measure a quality or speed improvement.

## Development

Use Node.js 22.18 or newer and npm.

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run --ignore-scripts
```

The checks use synthetic data. They require no model credentials or running OpenCode service.
The package exports TypeScript source, which the OpenCode plugin loader supports.
The client and plugin dependencies target OpenCode 2.0.32. Other version 2 releases need separate compatibility checks.
The package remains private in npm metadata until a release is ready. This GitHub repository is public.

## Check a local OpenCode connection

Start OpenCode normally, then run:

```sh
npm run doctor
```

The doctor discovers an existing service and reads its version. It does not start a service or submit a prompt.
It reports only a connection summary. It does not print credentials or the service registration.
A successful connection does not prove that task execution or the Harness² cycle works.

## Try the plugin locally

OpenCode 2.0.32 discovers a plugin file under `~/.config/opencode/plugins/` for every project. A local directory in the `plugins` configuration array is recorded and is not instantiated. Install the discovery shim. The installer records an absolute interpreter path from this package, so the OpenCode service working directory does not matter:

```sh
npm run build
node dist/cli.js install --python .venv/bin/python
```

A run stops at its deadline, 30 minutes unless `--max-duration-ms` sets another value up to two hours (7200000).
A k=1 cycle took about 35 minutes on 2026-10-22. Pass the same option to `uninstall`.

Projects stay disabled until an explicit opt-in. Remove the installation with `node dist/cli.js uninstall --python .venv/bin/python`. Private experience remains in the state directory.

## Safety boundaries

- Preserve the user's model and generation settings.
- Require project opt-in before future task execution or memory injection.
- Test candidates against copies of the same project snapshot.
- Never treat a Git worktree as a network or process sandbox.

A worker session must own its directory. OpenCode 2.0.32 gives a child session its parent's directory
and drops the requested location, so the runner creates a worker as a top-level session and reads the
location back before the first prompt. A location that is not the requested workspace raises instead of
prompting: a worker placed in the caller's project edits the checkout that started the cycle while the
adopted diff stays empty. `tests/runner.test.ts` reproduces the host rule and checks both directions.

A checkout may seed the auxiliary harness in `harness2/systemprompt.md` and `harness2/skills/*/SKILL.md`.
The cycle starts from that tree and keeps the adopted tree in its run record. A checkout without it
starts from one generic sentence.

A task worker receives `systemprompt.md` in its prompt, as the always-on component. Each skill is installed
as `.opencode/skills/<name>/SKILL.md` in the worker's workspace, and only a task worker may call the
`skill` tool, so a skill reaches the worker on demand and each load shows in its trajectory. A skill
named like one of the project's skills stops the run. The controller removes the installed skills before
the diff and stops the run if a worker changed one. An editor reads the skills as files and has no
`skill` tool.

A checkout may also declare `harness2/oracle.json`: up to eight commands, each with an argument list, a
directory inside the workspace, and optionally `CGO_ENABLED` or `GOFLAGS`. After selection the controller
runs them in the workspace copy of the chosen run and of each baseline run, keeps the logs under
`oracle/` in each execution, and reports `n_passed` of `n_criteria` in `result.oracle`. The checks never
feed selection. They run the project's own commands with the user's permissions, outside any sandbox.
Without the file the run reports `"oracle": "not_measured"`.
When the file names an `integratedRef`, such as `refs/remotes/origin/main`, the snapshot refuses any
`HEAD` other than that commit, so a cycle runs only on integrated work. The controller does not fetch.
The chosen harness is also written to `<run>/adopted-harness/`, ready to replace the checkout's `harness2/`.
- Do not rewrite mandatory instructions or expand permissions.
- Keep private experience out of public source control.
- Require evidence before adopting a lesson or claiming an improvement.

## References

- [OpenCode 2 plugins](https://opencode.ai/v2/docs/build/plugins)
- [OpenCode 2 client](https://opencode.ai/v2/docs/build/client)
- [OpenCode 2 migration contracts](https://opencode.ai/v2/docs/migrate-v1)
- [Harness² source and paper](https://github.com/google-research/harness2)

## License

Apache-2.0. Third-party projects retain their own licenses. This repository does not include Harness² source or benchmark datasets.
