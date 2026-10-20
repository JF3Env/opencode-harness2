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

- A native version 2 plugin entrypoint with a read-only `harness2_status` tool.
- A client connection check for an existing local OpenCode 2 service.
- Offline contract tests and a continuous integration workflow.

The plugin does not create sessions, call models, change prompts, or write memories.
It does not install itself globally. The Harness² controller remains future work.

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

Only the status tool exists at this stage. For an explicit local trial, add this entry to a project configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-harness2"]
}
```

Merge the entry with existing configuration. Do not replace unrelated settings.
Remove that entry to disable the trial. There is no memory or task state to remove at this stage.

## Safety boundaries

- Preserve the user's model and generation settings.
- Require project opt-in before future task execution or memory injection.
- Test candidates against copies of the same project snapshot.
- Never treat a Git worktree as a network or process sandbox.
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
