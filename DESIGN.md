# openrig-nodecode — design brief (frozen; builders implement, do not redesign)

An OpenRig community harness runner for nodecode (https://nodecode.ai). Zero npm runtime deps; Node >= 20 built-ins only. ESM ("type":"module"). Apache-2.0.

## References (read before building)
- Reference runner to port patterns from: /home/sam/code/movetheneedle/openrig/community-harnesses/agy-runner.mjs and its tests /home/sam/code/movetheneedle/tests/agy-runner.test.mjs (node:test style; port `parseArgs`, `memberOf`, `profileSkills`, `placeSkills`, `composeFirstPrompt`, `launchWrapperArgv`, `writeLaunchRecord`, `activityEndpoint`, `createInputParser`).
- OpenRig contract: /home/sam/code/openrig/openrig/docs/reference/harness-runner-contract.md, /home/sam/code/openrig/openrig/docs/reference/community-harness-presets.md, example runner /home/sam/code/openrig/openrig/docs/reference/community-harness-examples/dsh/openrig-dsh-runner.mjs (permission bridge + liveness beats live there).
- nodecode wire protocol: /home/sam/.local/share/nodecode/98dd6dc80/src/src/gateway/protocol.schema.json. Binary: `nodecode` on PATH (override env NODECODE_BIN).

## Layout
```
package.json            name openrig-nodecode, type module, bin {"openrig-nodecode-runner": "bin/nodecode-runner.mjs"}, scripts test="node --test tests/", lint="node --check bin/*.mjs src/*.mjs", install-preset
LICENSE                 Apache-2.0
README.md
presets/nodecode.yaml   Format-1 preset (see below)
bin/nodecode-runner.mjs main(); imports src/*; runs main only when executed directly
src/model-spec.mjs      parseModelSpec(str) -> {provider?, model?, effort?}
src/skills.mjs          memberOf, profileSkills, placeSkills, linkHomeSkills
src/launch.mjs          parseArgs, composeFirstPrompt, launchWrapperArgv, writeLaunchRecord, nodecodeArgv
src/session-probe.mjs   probeSession({ref, home, store, exec}) -> 'exists' | 'missing' | 'unreachable'
src/activity.mjs        createActivity(env) -> {post(hookEvent, subtype, extra), beat..., ask(question) , withdrawAll(reason)}
src/protocol.mjs        createFramer(onFrame) line splitter; createTurnTracker() state machine
scripts/install-preset.mjs
tests/*.test.mjs        node:test; fake nodecode = tests/fixtures/fake-nodecode.mjs replaying frames
```

## Preset (presets/nodecode.yaml)
```yaml
format: 1
name: nodecode
command: <ABS>/bin/nodecode-runner.mjs            # install-preset renders abs path + optional --agent-yaml/--startup-file/--profile
maintainer: "smota/openrig-nodecode"
limits: [honest list: shell UI not shown; permissions bridged from organism.questions only; model/provider/effort apply to fresh sessions only (session pinned on resume); default home shares the operator's organism unless --profile; node on pane PATH]
launch_result: true
runner: true
resume: true
first_input: true
passes_model: true
launch_wrapper: true
```
No shell syntax in command (no | & ; < > ( ) $( backtick quotes-unbalanced).

## Runner CLI
`nodecode-runner.mjs [--agent-yaml F] [--startup-file F]... [--workspace-root D] [--profile NAME] [--store PATH] [-- extra nodecode args]`
Workspace default: $OPENRIG_HOME/state/openrig-nodecode/<sessionName sanitized>. Seat member = memberOf(OPENRIG_SESSION_NAME) (`<pod>-<member>@<rig>`).

## Env read (all from process.env)
OPENRIG_LAUNCH_WRAPPER (JSON argv array; strip from child env; never fall back unwrapped; malformed -> exit 2 before spawn), OPENRIG_SESSION_NAME, OPENRIG_RESUME_REF, OPENRIG_MODEL, OPENRIG_LAUNCH_ATTEMPT, OPENRIG_LAUNCH_RESULT, OPENRIG_FIRST_INPUT (path; fresh launch only), OPENRIG_HOME, OPENRIG_URL|OPENRIG_HOST+OPENRIG_PORT, OPENRIG_ACTIVITY_HOOK_TOKEN (fallback $OPENRIG_HOME/activity-endpoint.json {baseUrl,token}), OPENRIG_NODE_ID, OPENRIG_OCCUPANT_GENERATION, OPENRIG_RUNTIME (default "nodecode"), NODECODE_BIN, NODECODE_HOME (default ~/.nodecode; with --profile the home is <NODECODE_HOME-parent>/profiles? -> NO: do not compute; pass `-p NAME` to nodecode and ask it: run `nodecode -p NAME` is not needed—home for linking = env NODECODE_HOME || ~/.nodecode, and when --profile given use ~/.nodecode/profiles/NAME if that dir exists else skip linkHomeSkills with a stderr note).

## Skills
1. placeSkills(workspace, agentYaml, member): `<ws>/.agents/skills/<id>` -> symlink to realpath(skill dir having SKILL.md); prune stale symlinks; mkdir 0700. (identical to agy)
2. linkHomeSkills(home, seatName, workspace): `<home>/cells/linked-skills/openrig-<seatName sanitized>` -> `<ws>/.agents/skills` (symlink; replace if stale; skip if `<home>/cells/linked-skills` dir missing, stderr note). nodecode discovers skills only through this link.

## Model
parseModelSpec("[provider/]model[:effort]"): split on first "/" -> provider only if prefix is in KNOWN_PROVIDERS? NO — keep it syntactic: prefix before first "/" = provider, suffix after last ":" = effort only if it matches /^(low|medium|high|max|minimal|xhigh)$/i; else whole remainder is model. Fields go on the FIRST start_turn.request of a FRESH launch only. On resume: ignore and print one stderr note (session pinned).

## Resume (strict)
If OPENRIG_RESUME_REF set: probeSession first. Probe: owner file `<store>.owner` (default store: <home>/history.db, sidecar <home>/history.db.owner (verified on nodecode 98dd6dc80); or beside --store PATH) JSON {pid,port}; token = env NODECODE_GATEWAY_OPERATOR_TOKEN || NODECODE_OPERATOR_TOKEN || read <home>/operator-token; GET http://127.0.0.1:<port>/api/gateway/sessions/<ref>/header with Authorization: Bearer <token>. 200 -> exists; 404 with code unknown_session -> missing; no owner -> run `nodecode [-p P] gateway on` (exec injectable), retry probe up to 15s; still none/other error -> unreachable.
- missing -> writeLaunchRecord({attempt, error:"missing"}), exit 3, spawn nothing.
- unreachable -> stderr, NO record, exit 2.
- exists -> spawn `nodecode rpc <ref>`.

## Spawn
argv = [...wrapper, NODECODE_BIN, ...(profile?['-p',profile]:[]), ...(store?['--store',store]:[]), 'rpc', ...(ref?[ref]:[]), ...extra]; stdio pipe; child env = process.env minus OPENRIG_LAUNCH_WRAPPER. Spawn error -> Stop/nodecode_exited, exit 127. Child exit -> withdraw asks, Stop/nodecode_exited, exit child code ?? 1. SIGTERM/SIGHUP -> cancel active turn (best effort), withdraw asks ("exited"), kill child, exit 143. Ctrl-C: active turn -> cancel_turn; no turn -> twice within 2s exits 130.

## Wire (stdout frames, JSON per line; non-JSON lines passed to stderr)
- payload.type session_stream_resumed (first; may come in chunks, `replay_chunk_final`): on the first one: nativeRef = frame.session_id || payload.session_id; if resumeRef && nativeRef !== resumeRef -> record {error:"missing"}, exit 3. Else writeLaunchRecord({attempt, nativeRef}) (O_EXCL 0600), post Stop/nodecode_ready, then if firstPrompt (fresh only) submit it.
- stdin start_turn: {type:"start_turn",command_id:"cmd-N",request:{prompt, ...modelFields(fresh first turn only)}}. Post UserPromptSubmit/accepted when gateway_turn_command_result arrives with status accepted|queued (turnId = result.response.turn_id); rejected -> stderr + Stop/error if nothing else pending.
- item_delta{turn_id, delta{type:text|reasoning|tool_call|stream_reset|fallback,...}}: text -> stdout; reasoning -> dim stderr (first 1 line per turn); tool_call -> print `⚙ name` + post PreToolUse/<name> (once per name+index); every delta -> throttled active/liveness beat (livenessSeconds 30, at most every 10s) with turnId.
- session_stream_event{frame:{event:{type}}}: turn.completed -> Stop/end_turn; turn.failed -> Stop/error (+Notification/runtime_error); turn.cancelled -> Stop/cancelled. On any: withdrawAll("turn_ended"|"turn_cancelled"), clear turnId, drain one queued operator prompt.
- organism.questions{questions:[{question_id,title,detail,choices,expires_at}]}: full set each time. New question -> POST /api/activity/permission-requests {sessionName,nodeId,generation,nativeRef,turnId,requestId:question_id,toolCall:{title,kind:"question"},options: choices mapped (first choice allow_once, others reject_once? NO: map up to 4 choices in order with kinds allow_once, reject_once, allow_always, reject_always; >4 choices -> take first 4 and note), occurredAt}. Then long-poll GET .../<askId>?waitSeconds=25 until answered|permitted|refused|withdrawn|stale; answered/permitted -> stdin answer_question{question_id, answer:<choice text for optionId>} + post active/permission_resolved; refused -> leave unanswered, print to TTY so operator can type the choice; question removed from set -> withdraw("turn_ended"). Unreachable OpenRig -> print question to TTY only (operator answers by typing the exact choice; runner maps a bare typed line equal to a pending choice to answer_question instead of start_turn).
- sync_protocol_error / gateway_turn_command_result rejected -> stderr.
- Idle: Stop/idle_heartbeat beat every 30s while no turn (livenessSeconds 60).

## Hooks
POST {baseUrl}/api/activity/hooks, Authorization: Bearer token, 2s timeout, serialized, body {sequence (monotonic int), sessionName, nodeId, generation, runtime:"nodecode", hookEvent, subtype, occurredAt ISO, turnId?, livenessSeconds?, askId?}. No endpoint -> all posts no-op.

## Exit codes
0 child clean, 2 bad args/wrapper/unreachable-on-resume, 3 missing resume, 127 spawn failed, 130 operator interrupt, 143 signal, else child code.

## Tests (node:test, no network except 127.0.0.1 fakes, temp dirs, must pass with `npm test`)
Unit: preset flags/no-shell-syntax; parseModelSpec table; parseArgs; profileSkills/placeSkills/linkHomeSkills (stale pruning); composeFirstPrompt; launchWrapperArgv; writeLaunchRecord 0600+O_EXCL; probeSession (fake http server: 200 / 404 unknown_session / no owner + fake exec).
Integration via fixtures/fake-nodecode.mjs (NODECODE_BIN=that script; replays a frame script from env FAKE_FRAMES path; records stdin to a file): fresh handshake -> record + Stop/nodecode_ready + first start_turn with model fields; resume ok; resume missing -> exit 3, no record nativeRef, no turn; mismatch ref -> exit 3; wrapper applied + env stripped; text deltas + PreToolUse + liveness; turn.completed -> Stop/end_turn; organism.questions -> permission request posted, answer -> answer_question on stdin; child exit -> Stop/nodecode_exited. Each seam with a planted-defect counterpart where cheap (assert the assertion can fail).
