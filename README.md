# openrig-nodecode

OpenRig community harness runner for [nodecode](https://nodecode.ai). Node >= 20, ESM, no runtime dependencies. Apache-2.0.

Why this exists, what is proved today and what comes next: [WHY.md](WHY.md).

## Install

```bash
npm install
```

The runner bin is `openrig-nodecode-runner` (`bin/nodecode-runner.mjs`). Nodecode itself is the `nodecode` binary on `PATH` (`NODECODE_BIN` overrides it).

Upgrade note: existing generated presets still carry explicit `--seat-profile auto`. From the desired persistent checkout, regenerate with `node scripts/install-preset.mjs --force`, preserving any custom installer arguments. An intentionally explicit `--seat-profile auto` continues to override `NODECODE_SEAT_PROFILE`.

## Preset

`presets/nodecode.yaml` is a Format-1 community harness. Install it with:

```bash
node scripts/install-preset.mjs [--force] [--agent-yaml F] [--startup-file F]... [--profile NAME]
```

`npm run install-preset --` accepts the same arguments. The script writes `${OPENRIG_HOME:-~/.openrig}/community-harnesses/nodecode.yaml`, sets `command` to the absolute path of `bin/nodecode-runner.mjs`, and appends every argument except `--force`. The preset defaults to `--default-seat-profile auto`, allowing environment selection. An explicit `--seat-profile`, legacy `--profile`, or custom `--default-seat-profile` is preserved without adding another profile flag. It refuses to overwrite an existing file unless `--force`, then prints the destination path.

## Env and flags

```text
nodecode-runner.mjs [--agent-yaml F] [--startup-file F]... [--workspace-root D] [--profile NAME] [--seat-profile auto|none|NAME] [--default-seat-profile auto|none|NAME] [--store PATH] [--resume-policy head|last-completed] [--no-openrig-cell] [-- extra nodecode args]
```

| Flag | Role |
| --- | --- |
| `--seat-profile auto\|none\|NAME` | Select or create a seat profile with an isolated session store and shared memory/skills. `auto` uses `openrig-` plus the session name lowercased and sanitized to letters, digits and hyphens. Overrides legacy `--profile` and both profile environment variables, including when set to `none`. The preset supplies a fallback of `auto`; the bare runner defaults to `none`. |
| `--profile NAME` | Use an existing Nodecode profile (legacy flag), without listing or creating profiles. Overrides environment selection and the preset fallback. |
| `--default-seat-profile auto\|none\|NAME` | Fallback selection when neither explicit profile flag nor profile environment variable is set. Named selections create only if absent, as with `--seat-profile`. |
| `--resume-policy head\|last-completed` | Overrides `OPENRIG_NODECODE_RESUME_POLICY` (default `head`). On verified resume, `last-completed` moves a failed, cancelled or interrupted head to the last completed turn before sending queued prompts. Fresh launches are unaffected. The preset selects `last-completed`. |
| `--no-openrig-cell` | Skip linking the bundled Openrig cell into the selected seat home. Existing entries are preserved. |

Profile precedence: `--seat-profile` → `--profile` → `NODECODE_SEAT_PROFILE` → `OPENRIG_NODECODE_SEAT_PROFILE` → `--default-seat-profile` → `none`. Empty environment values are treated as unset, so selection continues to the next source. Whitespace is not trimmed and is rejected as an invalid selected name. Explicit empty profile flags are also invalid. Names must start with a letter or digit and contain only letters, digits, dots, underscores or hyphens; selected names are validated before profile creation or launch.

Workspace default: `$OPENRIG_HOME/state/openrig-nodecode/<sessionName>`.

| Variable | Role |
| --- | --- |
| `OPENRIG_LAUNCH_WRAPPER` | JSON argv array applied to the nodecode child. Stripped from the child env. Malformed JSON exits 2 before spawn. Never starts unwrapped. |
| `OPENRIG_SESSION_NAME` | Seat name `<pod>-<member>@<rig>`. |
| `OPENRIG_NODECODE_NO_ANSWERS` | Test-only failure hook: `1` skips the answer subscription. Default launches always subscribe to questions for their native session before starting a turn. |
| `OPENRIG_NODECODE_RESUME_POLICY` | Resume policy: `head` (default) or `last-completed`; overridden by `--resume-policy`. |
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
| `NODECODE_SEAT_PROFILE` | Seat profile selection (`auto`, `none`, or a name), below explicit flags and above the preset fallback. |
| `OPENRIG_NODECODE_SEAT_PROFILE` | Compatibility alias, used when `NODECODE_SEAT_PROFILE` is unset or empty. |
| `NODECODE_BIN` | Nodecode binary. Default `nodecode` on `PATH`. |
| `NODECODE_HOME` | Nodecode home. Default `~/.nodecode`. Selected profiles resolve to `~/.nodecode/profiles/NAME` (Nodecode ignores `NODECODE_HOME` for profiles); skills link from `~/.nodecode/profiles/NAME` when that directory exists. |

## Openrig cell

At launch, the runner links `<seatHome>/cells/sam-openrig` to this checkout's `cells/openrig`, using the selected profile home or the default Nodecode home. An existing matching link is left in place; any other entry is preserved with a note. Use `--no-openrig-cell` to skip linking.

The cell exposes `rig_whoami`, `rig_queue_*`, `rig_send` and `rig_capture` as native tools, plus the `/rig` command. See the [Openrig cell README](cells/openrig/README.md) for tools and settings.

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
- A question reaches OpenRig only when every choice can be read as allow or reject (once or always); others are answered in the pane by typing the exact choice. Only the first four choices are offered through OpenRig.
- Model, provider, and effort apply to fresh sessions only. A resumed session stays pinned.
- The bare runner shares the operator's organism unless a profile flag or environment variable selects a profile. The preset selects a separate seat organism with `--default-seat-profile auto`, unless overridden.
- Node must be on the pane `PATH`.
- At launch, stale `openrig-*` skill links are pruned when their targets or marker workspace directories disappear. Other entries are preserved.

## Verification

Proved against nodecode 98dd6dc80 and OpenRig 0.7.1 (unit, fake and native tests via `npm test`; plus opt-in live steps via `npm run test:live`):

| Seam | Proof |
|---|---|
| Fresh launch | `nodecode rpc` on real gateway -> `OPENRIG_LAUNCH_RESULT` 0600 with `nativeRef` = session id |
| Resume | same ref -> same session; unknown ref -> `error: "missing"`, exit 3, no turn sent |
| Gateway down on resume | no record written, exit 2 |
| Preset | `GET /api/community-harnesses` reports `usable: true`; `rig spec preflight` of a rig with `runtime: nodecode` is ready, `runtime: bogus` is refused |
| Skills | seat skills linked into `<workspace>/.agents/skills` and `<home>/cells/linked-skills/openrig-<seat>` |

| Live rig (`npm run test:live`) | installed daemon, throwaway `rig create --runtime nodecode`: real model writes a file via `rig send`; `rig down --snapshot` + `rig launch` resumes the same session and the model recalls prior context; unknown runtime refused |

The opt-in native question proof (`OPENRIG_NATIVE_QUESTIONS=1 node --test --test-name-pattern='native operator question' tests/native.test.mjs`) uses fresh throwaway homes, stores and workspaces, copied provider config/credentials, and a fake OpenRig HTTP endpoint. A model prompt asks the native evaluator to run exactly:

```lisp
(multiple-value-list (ask-operator "openrig-test" :choices '("Allow" "Deny") :seconds 30))
```

The successful native run posted title `openrig-test` and choices `Allow`/`Deny`, took `Allow` through the endpoint poll response, and printed `("Allow" :ANSWERED)`. With the test-only subscription suppression hook it posted no permission requests and printed `My form was truncated; retrying with the full form.(NIL :NOBODY)`. This exercises native question delivery and answering through a fake endpoint; it does not exercise the installed OpenRig daemon's permission UI. Because the trigger is a model prompt, a run can fail on a model-side turn error (seen once in three runs: empty output, `runtime_error` hook); rerun before reading it as a bridge failure.

This is model-prompt evidence, not deterministic gateway form evaluation: the installed gateway protocol has no direct form-evaluation command. Of two focused attempts, the first produced empty final text and zero requests in both modes (both failed); the second passed both modes. The native question proof therefore remains opt-in and gives each run a 120-second deadline with process/server/temp cleanup. The default regression checks the exact subscription frame and its ordering before the first turn.

Not proved: behaviour under tmux pane loss/daemon restart mid-turn.

## Live rig proof

Run `npm run test:live` to exercise the installed OpenRig daemon on `:7433` through `rig` and tmux. The daemon must already be running, with the nodecode runtime installed and authenticated; `rig` and `tmux` must be on `PATH`. This uses the installed connector, not necessarily this checkout.

The opt-in test creates a temporary one-seat rig, observes startup and a real `proof.txt` write, snapshots and resumes the seat, checks recalled session memory in the pane, and rejects an unknown runtime. An `after()` hook deletes the throwaway rig and temporary directory. Ordinary `npm test` skips it unless `OPENRIG_LIVE_RIG=1`; live turns can consume model quota and each polling step allows up to 120 seconds.
