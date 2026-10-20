# Integration roadmap

## Target workflow

The user opens OpenCode normally in a project.
The plugin makes relevant approved experience available only for an opted-in project.
The user explicitly requests an improvement cycle when the extra execution cost is appropriate.
The cycle returns a proposed result, its evidence, and its resource use.

The integration targets OpenCode 2. It does not replace the executable with the OpenCode 1 checkout that Harness² pins.

## Current status

The repository contains the status plugin and a read-only client connection check.
No milestone below counts as complete on the strength of those two components alone.

## 1. OpenCode 2 execution adapter

- [x] Discover and authenticate with the version 2 service through the official client.
- [ ] Execute a bounded task in a separate session.
- [ ] Support both the task executor and the improvement editor through version 2.
- [ ] Read completion, errors, tool activity, and resource use from the version 2 contract.
- [ ] Propagate cancellation to active work.
- [ ] Preserve the user's selected model and generation settings.
- [ ] Verify the installed package entrypoints, not only a source-linked checkout.

**Acceptance:** a small task exercises execution and improvement-editor connections through OpenCode 2.
Capture actual outputs and errors. Do not invoke the pinned OpenCode 1 checkout.

The initial client connection check covers only the transport discovery portion of this milestone.

## 2. Real project task adapter

- [ ] Accept a repository, a task, and explicit completion criteria.
- [ ] Capture one initial project snapshot for all candidates.
- [ ] Preserve uncommitted user work and reject unsafe snapshot operations.
- [ ] Run candidates in separate worktrees or equivalent isolated copies.
- [ ] Define process, network, and external-action restrictions separately from filesystem copies.
- [ ] Return a diff for review without applying it to the original checkout.

**Acceptance:** candidate runs share the same initial inputs and leave the original checkout unchanged.
Task runs cannot publish, deploy, or access unrelated projects without explicit permission.

## 3. Harness² improvement cycle

- [ ] Reuse the upstream propose, probe, compose, and experience logic.
- [ ] Add version 2 execution and editor channels without rewriting the method.
- [ ] Limit the first candidate surface to auxiliary instructions and skills.
- [ ] Keep mandatory instructions, permissions, and existing plugins outside the editable surface.
- [ ] Retain an execution trail for each adopted or rejected change.
- [ ] Define a bounded invocation budget and stop behavior before a paid run.

**Acceptance:** one complete cycle records its baseline, candidates, composition, final execution, and supported experience.
A memory write or a prompt rewrite alone does not satisfy this criterion.
The restricted candidate surface is not equivalent to every editable component in the paper.

## 4. Persistent experience

- [ ] Keep project-private experience separate from reviewed, reusable general lessons.
- [ ] Store candidate lessons separately from approved lessons.
- [ ] Preserve the upstream experience and supporting evidence.
- [ ] Define versioning, duplicate handling, concurrent writes, and removal.
- [ ] Retrieve only relevant approved experience within a bounded context budget.
- [ ] Integrate with an existing lesson journal without creating conflicting sources of truth.
- [ ] Exclude secrets and raw private session logs from shared lessons.

**Acceptance:** a new session retrieves relevant experience from an earlier task after a restart.
A different project cannot read private experience. A stored lesson does not become a mandatory instruction automatically.

## 5. Global installation and controls

- [ ] Package the native plugin for explicit global installation.
- [ ] Keep execution and memory injection disabled until the project opts in.
- [ ] Add start, status, and cancel controls.
- [ ] Prevent worker sessions from starting nested improvement cycles.
- [ ] Verify coexistence with other orchestration and lesson plugins.
- [ ] Provide a removal path that restores the prior OpenCode behavior.

**Acceptance:** two projects use the same installed plugin without sharing private state.
Cancellation stops scheduled work. Removing the plugin requires no change to the OpenCode executable.

## 6. Controlled pilot

- [ ] Pass offline transport and lifecycle tests before any paid task run.
- [ ] Set the pilot task set and budget before execution.
- [ ] Compare normal and assisted execution from the same initial snapshots.
- [ ] Check outputs against independent completion criteria.
- [ ] Report correctness, latency, tokens, and cost when prices are available.
- [ ] Check experience reuse on a new task, not only the task that produced it.
- [ ] Keep failed, cancelled, and inconclusive runs visible.

**Acceptance:** the pilot report separates observed results from hypotheses.
Do not enable automatic improvement by default without evidence of a useful trade-off.

## Evidence policy

The repository checks use exit status zero as their pass criterion.
The test suite must also complete with no failed, skipped, cancelled, or pending tests.
For a handoff, retain each command, directory, numeric exit status, source snapshot, full log, and observed result.
Keep machine-local evidence under `.local/`, which Git ignores.
Do not publish private service metadata or raw model outputs as test evidence.

The doctor is a separate integration diagnostic. It does not certify the improvement method or prove model access.
