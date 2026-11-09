;;;; openrig.lisp --- OpenRig seat tools: rig whoami, queue, send as native tools
;;;;
;;;; The cell's code, in the package cell.lisp makes. Written as a file
;;;; (write-file, edit, or any editor): a write makes what changed live
;;;; and commits it. An eval defines live and keeps nothing.

(in-package #:sam-openrig)

(eval-when (:compile-toplevel :load-toplevel :execute)
  (shadow '("JSON-OBJECT" "JSON-ARRAY") '#:sam-openrig))

(defun json-object (&rest key-value-pairs)
  "Construct an EQUAL hash-table from alternating string keys and values."
  (let ((table (make-hash-table :test 'equal)))
    (loop for (key value) on key-value-pairs by #'cddr
          do (setf (gethash (string key) table) value))
    table))

(defun json-array (&rest elements)
  "Construct a JSON array vector from ELEMENTS."
  (apply #'vector elements))

(defun rig-bin ()
  "Return the configured rig binary from (setting :rig-bin), falling back to \"rig\"."
  (let ((configured (ignore-errors (setting :rig-bin))))
    (if (and (stringp configured) (plusp (length configured)))
        configured
        "rig")))

(defun run-rig (&rest args)
  "Run the rig binary (from setting :rig-bin) with ARGS plus \"--json\" via
sb-ext:run-program (:search t, 60 s max). Returns stdout text on exit 0, or a
string starting with \"rig failed (exit N): \" followed by stderr on non-zero
exit or failure. Never signals."
  (let ((stdout (make-string-output-stream))
        (stderr (make-string-output-stream))
        (proc nil))
    (handler-case
        (let* ((bin (rig-bin))
               (argv (append (mapcar #'princ-to-string args) (list "--json"))))
          (sb-ext:with-timeout 60
            (setf proc (sb-ext:run-program bin argv
                                           :search t
                                           :output stdout
                                           :error stderr)))
          (let ((code (or (and proc (sb-ext:process-exit-code proc)) -1))
                (out (get-output-stream-string stdout))
                (err (get-output-stream-string stderr)))
            (if (zerop code)
                out
                (format nil "rig failed (exit ~d): ~a"
                        code
                        (if (plusp (length err)) err out)))))
      (sb-ext:timeout ()
        (when (and proc (ignore-errors (sb-ext:process-alive-p proc)))
          (ignore-errors (sb-ext:process-kill proc sb-unix:sigkill)))
        (let ((err (get-output-stream-string stderr)))
          (format nil "rig failed (exit -1): timed out after 60s~@[ (~a)~]"
                  (and (plusp (length err)) err))))
      (error (condition)
        (let ((err (get-output-stream-string stderr)))
          (format nil "rig failed (exit -1): ~a~@[ (~a)~]"
                  condition
                  (and (plusp (length err)) err)))))))

(defun arg-string (args key)
  "Extract a non-empty string for KEY from hash-table ARGS, or NIL."
  (let ((value (and (hash-table-p args) (gethash key args))))
    (and (stringp value) (plusp (length value)) value)))

(defun tool-rig-whoami (args)
  (declare (ignore args))
  (run-rig "whoami"))

(defun tool-rig-queue-whoami (args)
  (declare (ignore args))
  (run-rig "queue" "whoami"))

(defun tool-rig-queue-show (args)
  (run-rig "queue" "show" (or (arg-string args "qitemId") "")))

(defun tool-rig-queue-claim (args)
  (run-rig "queue" "claim" (or (arg-string args "qitemId") "")))

(defun tool-rig-queue-update (args)
  (let ((qitem-id (or (arg-string args "qitemId") ""))
        (note (arg-string args "note"))
        (state (arg-string args "state"))
        (closure-reason (arg-string args "closureReason")))
    (apply #'run-rig
           (append (list "queue" "update" qitem-id)
                   (when note (list "--note" note))
                   (when state (list "--state" state))
                   (when closure-reason (list "--closure-reason" closure-reason))))))

(defun tool-rig-queue-handoff (args)
  (let ((qitem-id (or (arg-string args "qitemId") ""))
        (to (or (arg-string args "to") ""))
        (title (or (arg-string args "title") (arg-string args "summary") ""))
        (body (arg-string args "body")))
    (apply #'run-rig
           (append (list "queue" "handoff" qitem-id
                         "--to" to
                         "--summary" title)
                   (when body (list "--body" body))))))

(defun tool-rig-send (args)
  (run-rig "send"
           (or (arg-string args "seat") "")
           (or (arg-string args "text") "")))

(defun tool-rig-capture (args)
  (run-rig "capture" (or (arg-string args "seat") "")))

(defun rig-command (args &optional session-id)
  "Run /rig <args...> through RUN-RIG and return the daemon's JSON output."
  (declare (ignore session-id))
  (apply #'run-rig (if (listp args) args (split-words (or args "")))))

(define-cell openrig
  (:section ("openrig")
    ("rig-bin" :string :default "rig" :doc "path to the rig CLI"))
  (:tool "rig_whoami"
    (list :description
          "Ask the OpenRig daemon who this seat is (`rig whoami --json`). The daemon's answer is the authoritative managed identity for this seat (rig, pod, member, sessionName, runtime, peers, edges, and transcript path) — what the daemon actually routes and attributes this seat as, not what you remember or assume from earlier turns."
          :parameters
          (json-object
           "type" "object"
           "properties" (json-object)
           "required" (json-array)))
    'tool-rig-whoami)
  (:tool "rig_queue_whoami"
    (list :description
          "Ask the OpenRig daemon for this seat's current queue position (`rig queue whoami --json`). The daemon's answer is what the daemon thinks this seat holds right now (in-progress, pending, blocked, and recent active qitems), not what you remember holding."
          :parameters
          (json-object
           "type" "object"
           "properties" (json-object)
           "required" (json-array)))
    'tool-rig-queue-whoami)
  (:tool "rig_queue_show"
    (list :description
          "Ask the OpenRig daemon for one queue item's record and derived waiting state (`rig queue show <qitemId> --json`). The daemon's answer is the authoritative persisted row in the daemon ledger (owner, state, summary, body preview, audit notes, and blocker/waiting state), not what you remember the item saying."
          :parameters
          (json-object
           "type" "object"
           "properties" (json-object
                         "qitemId" (json-object
                                    "type" "string"
                                    "description" "Queue item ID to inspect"))
           "required" (json-array "qitemId")))
    'tool-rig-queue-show)
  (:tool "rig_queue_claim"
    (list :description
          "Claim a pending queue item in the OpenRig daemon (`rig queue claim <qitemId> --json`). The daemon's answer confirms whether the `pending -> in-progress` transition succeeded under this seat's transport identity and returns the daemon-computed `closure_required_at` deadline; only a daemon-confirmed claim means this seat actually holds the active work."
          :parameters
          (json-object
           "type" "object"
           "properties" (json-object
                         "qitemId" (json-object
                                    "type" "string"
                                    "description" "Queue item ID to claim"))
           "required" (json-array "qitemId")))
    'tool-rig-queue-claim)
  (:tool "rig_queue_update"
    (list :description
          "Append an audit note and/or mutate a queue item's state in the OpenRig daemon (`rig queue update <qitemId> [--note N] [--state S] [--closure-reason R] --json`). The daemon's answer is the committed row mutation in the daemon's queue ledger (a note without `state` never changes row state, and `state=done` requires `closureReason`); if the daemon refuses, the qitem's state did not change."
          :parameters
          (json-object
           "type" "object"
           "properties" (json-object
                         "qitemId" (json-object
                                    "type" "string"
                                    "description" "Queue item ID to update")
                         "note" (json-object
                                 "type" "string"
                                 "description" "Transition note for the audit log")
                         "state" (json-object
                                  "type" "string"
                                  "description" "New state: pending | in-progress | done | blocked | failed | denied | canceled | handed-off")
                         "closureReason" (json-object
                                          "type" "string"
                                          "description" "Required when state=done (handed_off_to | denied | canceled | no-follow-on | escalation | superseded)"))
           "required" (json-array "qitemId")))
    'tool-rig-queue-update)
  (:tool "rig_queue_handoff"
    (list :description
          "Transactionally hand off a queue item in the OpenRig daemon (`rig queue handoff <qitemId> --to <to> --summary <title> [--body <body>] --json`). The daemon's answer confirms that the source qitem was closed as `handed-off` and a new qitem owned by `to` was durably created (and nudged by default) in the daemon ledger — the hot potato has not passed until the daemon records both rows."
          :parameters
          (json-object
           "type" "object"
           "properties" (json-object
                         "qitemId" (json-object
                                    "type" "string"
                                    "description" "Source queue item ID being handed off")
                         "to" (json-object
                               "type" "string"
                               "description" "Destination seat session name receiving the new qitem (e.g. dev-qa@my-rig)")
                         "title" (json-object
                                  "type" "string"
                                  "description" "Short 1-2 sentence subject/summary of the new qitem (--summary on the rig CLI)")
                         "body" (json-object
                                 "type" "string"
                                 "description" "Optional new qitem body inline (omit to keep the source body)"))
           "required" (json-array "qitemId" "to" "title")))
    'tool-rig-queue-handoff)
  (:tool "rig_send"
    (list :description
          "Send a terminal message to a seat via the OpenRig daemon (`rig send <seat> <text> --json`). The daemon's answer reports what the delivery guard and terminal transport actually did (delivered, sent with busy/unknown-activity advisory, or refused by the interactive-prompt/permission guard) — pane delivery is not agent acknowledgement, and a guard refusal means nothing was typed into the target seat."
          :parameters
          (json-object
           "type" "object"
           "properties" (json-object
                         "seat" (json-object
                                 "type" "string"
                                 "description" "Target seat session name (e.g. dev-impl@my-rig)")
                         "text" (json-object
                                 "type" "string"
                                 "description" "Message text to send to the seat's terminal"))
           "required" (json-array "seat" "text")))
    'tool-rig-send)
  (:tool "rig_capture"
    (list :description
          "Capture terminal output from a seat's pane via the OpenRig daemon (`rig capture <seat> --json`). The daemon's answer is what is actually drawn on the target seat's terminal right now (captured lines, activity indicator, promptPane dimensions, and inputBox status distinguishing typed input from faint harness ghost-text suggestions), not what you assume the peer is doing."
          :parameters
          (json-object
           "type" "object"
           "properties" (json-object
                         "seat" (json-object
                                 "type" "string"
                                 "description" "Target seat session name to capture (e.g. dev-impl@my-rig)"))
           "required" (json-array "seat")))
    'tool-rig-capture)
  (:command "rig" 'rig-command
    :description "Run a rig CLI command with --json and show the OpenRig daemon's response"))
