I found 16 defects: 2 blockers, 5 major, 9 minor.

**Limits of this review:**
- I couldn't read `harness-runner-contract.md` or nodecode's `protocol.schema.json` (permission was denied), so I checked against `DESIGN.md` only. Nothing below was confirmed against those two files.
- I didn't run anything. Every finding comes from reading the code.

## Blocker

1. **A resume with `--profile` checks the wrong gateway and can wrongly report the session as missing.** `bin/nodecode-runner.mjs:68,87` versus `:98`
   - **What breaks:** `probeSession` always looks in `home` (`NODECODE_HOME` or `~/.nodecode`) for `store/*.owner` and `operator-token`. When a profile is set, the runner uses `~/.nodecode/profiles/NAME` for skills, but the probe still asks the default gateway. That gateway answers `404 unknown_session`, so the runner writes `{error:"missing"}` and exits 3. OpenRig treats that as final and starts a fresh session.
   - **Trigger:** resume any seat whose preset passes `--profile P`, where session R only exists under profile P.

2. **The resume probe starts `nodecode gateway on` without the launch wrapper, and with the seat's environment.** `bin/nodecode-runner.mjs:81-84`
   - **What breaks:** `execFile(bin, …)` runs directly. `OPENRIG_LAUNCH_WRAPPER` is ignored here even though the contract says never to fall back to running unwrapped.
   - **Env leak:** the long-lived, shared gateway daemon also inherits `childEnv`. That includes `OPENRIG_ACTIVITY_HOOK_TOKEN`, `OPENRIG_SESSION_NAME`, `OPENRIG_NODE_ID` and `OPENRIG_LAUNCH_RESULT`, and they stay with the daemon after the seat ends.
   - **Trigger:** resume with a wrapper set while no `*.owner` file exists.

## Major

3. **One failed long-poll stops the permission bridge for good.** `src/activity.mjs:93-96`
   - **What breaks:** `call()` returns `null` on any non-2xx, timeout or reset, and on a reply that isn't JSON. The loop then calls `manual()`, sets `keep`, and returns. A later answer in OpenRig is never sent to nodecode.
   - **Trigger:** a proxy 502/504, a daemon restart, or any network blip during the 25 s wait.

4. **A question with no `choices` array crashes the frame handler or the whole runner.** `bin/nodecode-runner.mjs:153,157,181`
   - **What breaks:** three places assume `question.choices` is an array:
     - With no activity endpoint, `printQuestion` throws inside `handleFrame`. That goes to `finish(2, {kill:true})` and the seat is killed.
     - In `submit`, any line the operator types throws inside the input handler. That is an uncaught exception: the runner dies with the terminal left in raw mode and nodecode left running.
   - **Trigger:** a free-text question in `organism.questions`.

5. **Hooks are still posted after `Stop/nodecode_exited`.** `bin/nodecode-runner.mjs:272,276,284-286` against `finish` at `:195-210`
   - **What breaks:** `handleFrame` only checks `ending` when it starts. If a frame is waiting on `post()` when SIGTERM arrives, `finish` queues `nodecode_exited`. The frame then carries on and posts `PreToolUse`, `liveness`, `Notification/runtime_error` or `Stop` with a higher sequence number than the exit hook.
   - **Trigger:** SIGTERM or a double Ctrl-C during a `turn.failed` frame or a tool-call delta.

6. **No liveness beats while a turn produces no deltas.** `bin/nodecode-runner.mjs:134,274-277`
   - **What breaks:** `work()` stops the interval beats and `startWorkBeats` is never called. During a turn, a beat is only sent when a delta arrives. Each beat promises `livenessSeconds:30`, so OpenRig sees the seat as stale once a gap runs past 30 s.
   - **Trigger:** a tool call that runs for more than 30 s without output, such as a build or test run.

7. **Questions aren't tied to this seat's session, and they're withdrawn when a turn ends.** `bin/nodecode-runner.mjs:286-287,293-305`
   - **What breaks:** two related problems:
     - `organism.questions` is the organism-wide set. Without `--profile`, the organism is the operator's shared one, so questions from other sessions are bridged to this seat and can be answered from it.
     - At turn end, `withdrawAll` plus `questions.clear()` withdraws questions that are still open in nodecode. They are re-posted with `turnId: null` on the next frame.
   - **Trigger:** two nodecode sessions in the default organism, or a question that outlives its turn.

## Minor

8. **Ctrl-C and `/abort` do nothing when the active turn has no id, and Ctrl-C can't exit either.** `bin/nodecode-runner.mjs:128-131,212,234`; `src/protocol.mjs:55`
   - **What breaks:** `busy` is true but `cancel()` has nothing to send, and `interrupt` never moves on to exiting. In raw mode Ctrl-C doesn't raise SIGINT, so the operator is stuck until the turn ends.
   - **Trigger:** a resume replay with `admission_state:"active"` but no turn id, or an `accepted` result with no `turn_id`.

9. **A resume handshake without `session_id` is declared missing.** `bin/nodecode-runner.mjs:224-226`
   - **What breaks:**
     - On resume, an `undefined` nativeRef fails the `!== resumeRef` check. The runner writes `missing` and exits 3, even though the probe just found the session.
     - On a fresh launch, the same frame returns without setting `ready`. If no later chunk carries an id, the seat hangs with no launch record.
   - **Trigger:** the id only appears on a later chunk or under a different key.

10. **A stale owner file never triggers `gateway on`.** `src/session-probe.mjs:32,43`
    - **What breaks:** a parseable `{port}` skips the start step. The probe then gets connection-refused errors for 15 s, returns `unreachable`, and the runner exits 2. The `pid` isn't checked.
    - **Trigger:** the gateway crashed and left `*.owner` behind.

11. **A relative `--store` resolves to different paths for the probe and for nodecode.** `bin/nodecode-runner.mjs:87` versus `:308`
    - **What breaks:** the probe reads `<runner cwd>/<store>.owner`, but nodecode is spawned with `cwd: workspace`.
    - **Trigger:** `--store store/x`.

12. **A malformed frame field kills the seat.** `bin/nodecode-runner.mjs:267,294,311`
    - **What breaks:** a non-array `questions` throws at `.map`. A non-string reasoning `delta.text` throws at `.split`. Either way, the frame-error path calls `finish(2, {kill:true})`.

13. **A spurious withdraw is sent after a question was answered through OpenRig.** `bin/nodecode-runner.mjs:295-297`; `src/activity.mjs:60-64`
    - **What breaks:** after `onAnswer`, the ask task returns but `state.ended` stays false. When nodecode then drops the question, the runner calls `withdraw('turn_ended')` and posts `/withdraw` for an ask that is already answered.
    - **Related:** `activity.mjs:88-89` posts `permission_resolved` even when `answer()` returned false because the stdin write failed.

14. **Writing to the runner's stdout has no error handler.** `bin/nodecode-runner.mjs:265,321`
    - **What breaks:** when the pane closes, `output.write` raises EPIPE as an uncaught exception. The runner dies without withdrawing asks or posting `nodecode_exited`.

15. **Model fields are lost if the first `start_turn` is rejected.** `bin/nodecode-runner.mjs:141-142`
    - **What breaks:** `firstTurn = false` is set before the gateway accepts the turn. The next prompt starts the session without the provider, model and effort from `OPENRIG_MODEL`.

16. **One bad skill entry blocks the launch with exit 2.** `src/skills.mjs:59,66,93`
    - **What breaks:** `realpathSync` throws on a missing path. `rmSync` without `recursive` throws on a real directory sitting where the link should go. Either error goes to the setup catch and the runner exits 2 ("bad args").

There is also one small leftover: answered questions stay in `questions`, so `maybeCloseInput` (`:136`) won't close nodecode's stdin in non-TTY mode until the turn ends.
claude exit 0
