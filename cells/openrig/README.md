# openrig (`sam-openrig`)

OpenRig seat tools for Nodecode: exposes `rig whoami`, `rig queue`, `rig send`, and `rig capture` as first-class native tools (plus the `/rig` slash command), always invoking the `rig` CLI with `--json`.

## What This Cell Gives

A Nodecode seat running inside an OpenRig topology needs daemon-authoritative state rather than conversational memory. This cell registers eight native model tools and one slash command in the `sam-openrig` package (`cells/openrig/cell.lisp` + `cells/openrig/openrig.lisp`, loaded in order by `cells/openrig/sam-openrig.asd`):

- Every call runs through `(run-rig &rest args)`, which executes the configured `rig` binary via `sb-ext:run-program` (`:search t`, bounded to 60 seconds) with `"--json"` appended.
- On exit `0`, `run-rig` returns standard output verbatim.
- On non-zero exit, timeout, or process launch error, `run-rig` never signals a Lisp condition; it returns `"rig failed (exit N): <stderr>"`.

## How the Runner Links It

At seat launch, the OpenRig Nodecode runner links this directory into the seat's Nodecode home as:

```text
<home>/cells/sam-openrig -> <repo>/cells/openrig
```

When Nodecode boots on `<home>`, its folder loader (`nlk:load-cells`) discovers `cells/sam-openrig/sam-openrig.asd`, loads `cell.lisp` then `openrig.lisp`, and starts the `openrig` cell (`sam-openrig:start-cell`).

## Settings

The cell declares one configuration section in Nodecode's shared config (`config.jsonc` / `/settings`):

```jsonc
{
  "openrig": {
    "rig-bin": "rig"
  }
}
```

| Section | Key | Type | Default | Reader | Description |
| --- | --- | --- | --- | --- | --- |
| `openrig` | `rig-bin` | `:string` | `"rig"` | `(setting :rig-bin)` | Path or command name of the `rig` CLI binary (searched on `PATH` via `:search t`). |

## Native Tools

| Tool Name | Parameters | Underlying `rig` CLI Command | What the Daemon's Answer Means |
| --- | --- | --- | --- |
| `rig_whoami` | *(none)* | `rig whoami --json` | The authoritative managed identity of this seat (`rig`, `pod`, `member`, `sessionName`, `runtime`, `peers`, `edges`, `transcriptPath`) — who the daemon actually routes and attributes this process as, not what the seat remembers from prior turns. |
| `rig_queue_whoami` | *(none)* | `rig queue whoami --json` | What the daemon thinks this seat holds right now (`in-progress`, `pending`, `blocked`, and recent active queue items), not what the seat remembers holding. |
| `rig_queue_show` | `qitemId` (string, required) | `rig queue show <qitemId> --json` | The authoritative persisted record and derived waiting/blocker state for `<qitemId>` in the daemon's queue ledger, not cached or remembered state. |
| `rig_queue_claim` | `qitemId` (string, required) | `rig queue claim <qitemId> --json` | Confirms whether the `pending -> in-progress` claim succeeded under this seat's transport identity and reports the daemon-computed `closure_required_at` deadline; only a daemon-confirmed claim means this seat owns the active work. |
| `rig_queue_update` | `qitemId` (string, required), `note` (string, optional), `state` (string, optional), `closureReason` (string, optional) | `rig queue update <qitemId> [--note <note>] [--state <state>] [--closure-reason <closureReason>] --json` | The committed mutation on `<qitemId>` in the daemon's queue ledger (a note alone never changes state, and `state=done` requires `closureReason`); if the daemon rejects the update, the row's state did not change. |
| `rig_queue_handoff` | `qitemId` (string, required), `to` (string, required), `title` (string, required), `body` (string, optional) | `rig queue handoff <qitemId> --to <to> --summary <title> [--body <body>] --json` | Confirms the transactional handoff in the daemon ledger: the source qitem is closed as `handed-off` and a new qitem owned by `<to>` with summary `<title>` is durably created (and nudged by default). Work has not moved until the daemon records both rows. |
| `rig_send` | `seat` (string, required), `text` (string, required) | `rig send <seat> <text> --json` | What the daemon's delivery guard and terminal transport actually did (delivered, sent with busy/unknown-activity advisory, or refused by the interactive-prompt/permission guard). Pane delivery is not agent acknowledgement, and a guard refusal means nothing was typed. |
| `rig_capture` | `seat` (string, required) | `rig capture <seat> --json` | What is actually rendered on `<seat>`'s terminal pane right now (captured lines, activity state, `promptPane` size, and `inputBox` status distinguishing user-typed text from faint harness ghost-text suggestions), not what you assume the peer is doing. |

## Slash Command

| Command | Arguments | Underlying `rig` CLI Command | What the Daemon's Answer Means |
| --- | --- | --- | --- |
| `/rig` | `<args...>` | `rig <args...> --json` | Splits the rest of the command line into words, runs `run-rig` with those arguments plus `--json`, and returns the daemon's raw JSON output (or `"rig failed (exit N): ..."` on non-zero exit). |
