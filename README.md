# openrig-nodecode

OpenRig community harness runner for [nodecode](https://nodecode.ai). Node >= 20, ESM, no runtime dependencies. Apache-2.0.

## Install

```bash
npm install
```

The runner bin is `openrig-nodecode-runner` (`bin/nodecode-runner.mjs`). Nodecode itself is the `nodecode` binary on `PATH` (`NODECODE_BIN` overrides it).

## Preset

`presets/nodecode.yaml` is a Format-1 community harness. Install it with:

```bash
node scripts/install-preset.mjs [--force] [--agent-yaml F] [--startup-file F]... [--profile NAME]
```

`npm run install-preset --` accepts the same arguments. The script writes `${OPENRIG_HOME:-~/.openrig}/community-harnesses/nodecode.yaml`, sets `command` to the absolute path of `bin/nodecode-runner.mjs`, and appends every argument except `--force`. It refuses to overwrite an existing file unless `--force`, then prints the destination path.

## Env and flags

```text
nodecode-runner.mjs [--agent-yaml F] [--startup-file F]... [--workspace-root D] [--profile NAME] [--store PATH] [-- extra nodecode args]
```

Workspace default: `$OPENRIG_HOME/state/openrig-nodecode/<sessionName>`.

| Variable | Role |
| --- | --- |
| `OPENRIG_LAUNCH_WRAPPER` | JSON argv array applied to the nodecode child. Stripped from the child env. Malformed JSON exits 2 before spawn. Never starts unwrapped. |
| `OPENRIG_SESSION_NAME` | Seat name `<pod>-<member>@<rig>`. |
| `OPENRIG_RESUME_REF` | Resume this nodecode session. Probed before spawn. |
| `OPENRIG_MODEL` | `[provider/]model[:effort]` on the first turn of a fresh launch only. |
| `OPENRIG_LAUNCH_ATTEMPT` | Attempt id written into the launch record. |
| `OPENRIG_LAUNCH_RESULT` | Path of the launch-result record. |
| `OPENRIG_FIRST_INPUT` | Path of the first prompt. Fresh launch only. |
| `OPENRIG_HOME` | OpenRig home. |
| `OPENRIG_URL` or `OPENRIG_HOST` + `OPENRIG_PORT` | OpenRig base URL. |
| `OPENRIG_ACTIVITY_HOOK_TOKEN` | Bearer token. Fallback: `$OPENRIG_HOME/activity-endpoint.json` `{baseUrl,token}`. |
| `OPENRIG_NODE_ID` | Seat node id on activity posts. |
| `OPENRIG_OCCUPANT_GENERATION` | Occupant generation on activity posts. |
| `OPENRIG_RUNTIME` | Runtime name. Default `nodecode`. |
| `NODECODE_BIN` | Nodecode binary. Default `nodecode` on `PATH`. |
| `NODECODE_HOME` | Nodecode home. Default `~/.nodecode`. With `--profile`, skills link from `~/.nodecode/profiles/NAME` when that directory exists. |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Child exited cleanly. |
| 2 | Bad args, bad launch wrapper, or resume probe unreachable. |
| 3 | Resume session missing. |
| 127 | Spawn failed. |
| 130 | Operator interrupt. |
| 143 | SIGTERM or SIGHUP. |
| other | Child exit code. |

## Limits

- Shell UI is not shown.
- Permissions are bridged from `organism.questions` only.
- Model, provider, and effort apply to fresh sessions only. A resumed session stays pinned.
- The default home shares the operator's organism unless `--profile` is set.
- Node must be on the pane `PATH`.
- Skill links under `<home>/cells/linked-skills/openrig-<seat>` are not removed when a rig is deleted; prune them by hand.

## Verification

Proved against nodecode 98dd6dc80 and OpenRig 0.7.1 (`npm test`: 72/72 unit, node:test, fake and native; plus 6 opt-in live steps via `npm run test:live`):

| Seam | Proof |
|---|---|
| Fresh launch | `nodecode rpc` on real gateway -> `OPENRIG_LAUNCH_RESULT` 0600 with `nativeRef` = session id |
| Resume | same ref -> same session; unknown ref -> `error: "missing"`, exit 3, no turn sent |
| Gateway down on resume | no record written, exit 2 |
| Preset | `GET /api/community-harnesses` reports `usable: true`; `rig spec preflight` of a rig with `runtime: nodecode` is ready, `runtime: bogus` is refused |
| Skills | seat skills linked into `<workspace>/.agents/skills` and `<home>/cells/linked-skills/openrig-<seat>` |

| Live rig (`npm run test:live`) | installed daemon, throwaway `rig create --runtime nodecode`: real model writes a file via `rig send`; `rig down --snapshot` + `rig launch` resumes the same session and the model recalls prior context; unknown runtime refused |

Not proved: behaviour under tmux pane loss/daemon restart mid-turn; permission bridge against a real question prompt (fake-nodecode only).

## Live rig proof

Run `npm run test:live` to exercise the installed OpenRig daemon on `:7433` through `rig` and tmux. The daemon must already be running, with the nodecode runtime installed and authenticated; `rig` and `tmux` must be on `PATH`. This uses the installed connector, not necessarily this checkout.

The opt-in test creates a temporary one-seat rig, observes startup and a real `proof.txt` write, snapshots and resumes the seat, checks recalled session memory in the pane, and rejects an unknown runtime. An `after()` hook deletes the throwaway rig and temporary directory. Ordinary `npm test` skips it unless `OPENRIG_LIVE_RIG=1`; live turns can consume model quota and each polling step allows up to 120 seconds.
