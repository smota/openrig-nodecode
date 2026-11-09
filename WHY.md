# Why nodecode as an OpenRig seat

OpenRig keeps the seat's chair. nodecode keeps the seat's mind.

This page states the value, what is current, and what is next. Facts cite
OpenRig 0.7.x docs/source (`CAP` = `packages/daemon/context-packs-src/onboarding-width/public-what-you-can-do.md`)
and nodecode docs (https://nodecode.ai/docs). Opinions are marked as such.

## 1. The problem OpenRig's audience has

A seat is meant to live for weeks. OpenRig says so itself:

> "Your terminal buffer is not a record and your turn is not a container. A durable row survives
> your context, your compaction and your replacement - and it is the only thing that does." (CAP:356)

> "After a compaction, a /clear or a restart, your summary of the work is testimony, not evidence."
> (openrig-world/workflow/contributing-with-agents.md:177)

So OpenRig built machinery around a weakness of the harness underneath:

```
 what OpenRig does to keep a seat alive        because the built-in harness...
 ---------------------------------------------  ----------------------------------------------
 rig compact-plan / rig compact                 hits a context wall and forgets
   ("submitted, unconfirmed")                     (Claude-only; others "out of scope",
 refocusing skill, 3 strikes -> issue              claude-compaction-enforcer.ts:13-36)
 handover / apprentice-handover                 persists nothing but a transcript
 restore-packet write/read                        (OpenRig keeps only a resume token;
 rig transcript (reaches past a handover)         "nothing is read back", claude-code-adapter.ts:435)
 rig seat set-resume-token                      cannot tell OpenRig how full it is
 context-usage-threshold watchdog
```

Across restarts a built-in seat gets exactly one thing from OpenRig: a native conversation id
(`domain/runtime-adapter.ts:145-157`). No memory object exists on either side. Skills survive
only because they are files on disk.

## 2. What nodecode gives out of the box

| Seat need | Claude Code / Codex seat | nodecode seat (today) | Value |
|---|---|---|---|
| Survive the context wall | lossy summary; managed `/compact` Claude-only, "submitted, unconfirmed" (CAP:929-960) | agent edits its own context; dropped blocks are recallable; auto-eviction past 85% (docs: context) | no compaction cliff; recall is verifiable, not testimony |
| Memory across weeks | transcript only | `define-memory` / `define-skill` in a git-tracked knowledge cell, loaded every boot (docs: eval, operations) | the seat gets fitter per task instead of resetting per occupant |
| Handover without loss | occupant replaced, predecessor context erased, reachable via `rig transcript` (CAP:178-187, 836-841) | the layer (definitions, hooks, memory, skills) is the seat's competence, independent of any session; profiles export/import/clone (docs: profiles) | hand over the home, not three weeks of transcript |
| Restore after crash | token kept; missing conversation -> `awaiting-decision` (CAP:584-595); restore artery has no stub scenario | interrupted turns resume at next boot; gateway autostarts and restarts on crash (docs: sessions, gateway); **proved here**: `rig down --snapshot` then `rig launch` resumes with memory intact | fewer `partially_restored` rigs |
| Undo a bad turn | none | `/undo`, checkpoint tree, `navigate_checkpoint` over rpc, workspace snapshots (docs: sessions) | rewind beats relaunch |
| Parallel sub-work | separate seats or subagents | `(fork ...)` x4 sharing full context; session `/fork` tree copies nothing | cheaper than a pod for bounded fan-out |
| Rollback of the agent itself | n/a | `(generations)` / `nodecode rollback N` (docs: eval) | a self-modifying seat is only safe if it can be put back |
| Self-authored tools | static skill markdown | cells: a `/command`, tool or scheduled job built by talking, shareable via `nc://NAME`, no restart (docs: cells) | the seat grows the verbs the rig needs and ships them to peers |
| Headless protocol | TTY scraping + hooks | `nodecode rpc` JSONL with durable replay and `organism.questions` (docs: rpc) | full runner contract with zero OpenRig core changes |

The value column is opinion. The two columns before it are cited fact.

## 3. Current state (what this repo proves)

| Seam | Proof |
|---|---|
| Runner contract | launch_result, resume, first_input, passes_model, launch_wrapper, activity hooks, permission bridge, skill projection - 72 unit tests, fake + native nodecode |
| Checkpoint-aware resume | Implemented: `--resume-policy last-completed` rewinds a failed, cancelled or interrupted head before queued prompts; proved by fake + native test. |
| Strict resume | unknown `OPENRIG_RESUME_REF` -> `error: "missing"`, exit 3, no turn sent (nodecode would otherwise silently create a blank session) |
| Live rig (`npm run test:live`) | installed daemon, throwaway `rig create --runtime nodecode`: model writes a file via `rig send`; snapshot + launch resumes the same session and the model recalls prior context; unknown runtime refused |
| Preset | `GET /api/community-harnesses` usable; `rig spec preflight` accepts `runtime: nodecode` |
| Identity | runner posts `session_identity`, seat shows verified |

Known limits (also in README):

- Permissions reach OpenRig only via `organism.questions`; no turn-cancel verb (OpenRig gap for all community harnesses, CAP:651).
- `rig transcript --wake` cannot ask a nodecode seat (CAP:187).
- Model/provider/effort apply to fresh sessions; resumed sessions stay pinned.
- Default home shares the operator's organism; use `--profile` to isolate seats.
- Not proved: pane loss / daemon restart mid-turn; permission bridge against a real prompt.

## 4. Next: not out of the box, but architectable

```
                 effort ->
 value ^  +--------------------------+-------------------------------+
          | A. openrig cell          | D. Handover from memory        |
   high   |    queue/whoami/send     |    layer+memory export is the  |
          |    tools inside the image|    restore packet; successor   |
          |                          |    imports, reads no transcript|
          +--------------------------+-------------------------------+
          | B. context-usage hook    | E. checkpoint-aware restore    |
   mid    |    -> OpenRig watchdog   |    navigate_checkpoint to last |
          | C. cancel + full         |    good turn on bad restore    |
          |    permission bridge     |                                |
          +--------------------------+-------------------------------+
                   small                         larger
```

| # | Idea | Why | Where | Core change |
|---|---|---|---|---|
| A | `openrig` cell (`nc://openrig`): `rig queue whoami/claim/handoff`, `rig send`, `rig whoami --json` as native tools, auto-linked by the runner | the seat stops reasoning about the queue from memory ("what the daemon thinks you hold, not what you remember holding", CAP:51) | this repo | no |
| B | context-usage -> OpenRig hook: runner posts the image's real window usage so the `context-usage-threshold` watchdog fires on data; the action becomes "edit context", not "compact" | replaces guessing | runner | no |
| C | map OpenRig turn-cancel to `cancel_turn`; bridge every ask | closes the two gaps OpenRig names for community harnesses | runner | cancel verb for community presets is an upstream Ideas item |
| D | handover = profile export/import: `rig handover` on a nodecode seat writes `nodecode profile export` as the restore packet | handover with zero context loss; what `restore-packet` (CAP:820) reaches for | runner + `handover` compaction_strategy | no |
| E | checkpoint-aware restore: on `partially_restored` or a bad turn, `navigate_checkpoint` to the last turn that completed a queue row | turns `awaiting-decision` into a reversible automatic choice | runner + rig verbs | no |
| F | `rig transcript --wake` for nodecode via `nodecode rpc` | parity with Claude/Codex seats | runner + transcript route | yes, small |
| G | linked knowledge cells across a pod | pod-level memory; OpenRig has none today | profiles + runner link step | no |

Recommended order: A + B (small, pure connector work), then D as the headline.

## 5. Caveats

- nodecode capabilities come from published docs plus the live image; only resume + memory were exercised under an OpenRig seat.
- OpenRig pains are quoted from its 0.7.x docs and may move.
