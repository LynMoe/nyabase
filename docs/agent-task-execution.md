# Stateless Agent Task Architecture

Status: implementation directive.

This repository is unpublished and has no deployed database. The implementation
is a clean cutover. Compatibility aliases, old routes, dual execution paths,
legacy migrations, workflow engines, and Agent-owned recovery journals are
forbidden.

## 1. Objective

Backend is the only durable owner of task execution state. Agent owns static
configuration and transient process memory only. It never persists a task,
checkpoint, result, desired RemoteFS specification, or credential.

The supported guarantee is:

> While a Backend task is pending, every delivery asks Agent to converge the
> same stable resource identity toward the same immutable target. If Agent or
> the connection disappears, Backend sends the same task again. When Backend
> receives a verified result, it commits exactly one immutable success or
> failure.

This is logical once-per-task completion and at-least-once physical execution.
It is not a distributed transaction and does not promise exactly-once Docker,
mount, filesystem, quota, or process calls.

## 2. One high-level task, no durable steps

`AgentTask` remains the only task concept:

- Database: `agent_tasks`
- REST: `/agent-tasks` and `/admin/agent-tasks`
- IDs: `taskId`, `activeTaskId`, `lastTaskId`
- WebSocket: `task.execute.v1`, `task.result.v1`, `task.accepted.v1`
- Agent durable state: none

One task targets one authenticated Agent and one high-level desired effect.
Handler implementation may call several local functions, but Backend does not
store or dispatch those calls as steps. There is no attempt, phase, work item,
workflow, distributed lease, durable attempt fence, retry identity, or
compensation framework. Process, session, and physical-mutation fences remain
small fail-closed guards rather than durable workflow state.

Multi-server requests create one independent task per server. There is no
cross-server atomic batch.

## 3. Supported steady states

Every task/resource pair must be explainable as one of these states:

1. `pending`: Backend retains the task and resource lock. Agent may be offline,
   executing, or recovering. A timeout never fabricates physical success or
   absence; bounded expiry either proves that no send occurred or enters the
   quarantined state below.
2. `succeeded`: Agent verified the physical target and Backend atomically
   committed the finalizer, terminal task, domain state, and lock release.
3. `failed-managed`: Backend stored a verified ordinary failure, atomically
   projected its observable resource state, and released the task locks. Any
   partial resource is discoverable through a stable resource ID and may be
   removed or converged through a new high-level intent.
4. `failed-quarantined`: an ambiguous outcome, safety-critical failure,
   malformed terminal evidence, runtime-cleanup failure, or exhausted database
   finalizer is visible as terminal failure while the exact task locks (and any
   staged evidence) remain retained. The Server is quarantined and an
   administrator may retry only the same immutable task after repairing the
   fault; new physical intents cannot overlap it.

`failed` does not mean rollback. Automatic rollback is deliberately excluded:
deleting a partially-created resource can destroy useful evidence or race an
operator. Cleanup is an explicit `ensure absent` task. A managed failure is
followed by a new intent; a quarantined failure is recovered only by explicitly
reopening the same immutable task while its original locks still exclude every
overlapping intent.

Hidden, unlabelled, Agent-journal-only, or silently locked states are not
supported steady states. An unobservable physical outcome is visibly
`pending + locked` within the uncertainty bound, then visibly
`failed + locked + quarantined` with an explicit retry action. Neither is
treated as physical success or safe absence.

## 4. Fault-model boundary

The design supports:

- lost or duplicate execute/result/accepted messages;
- any Backend API/Gateway/Worker process restart with PostgreSQL intact;
- Agent process or host restart with no Agent recovery directory;
- connection loss before, during, or after a physical effect;
- a physical effect completing before its result is delivered;
- finalizer rollback and duplicate terminal results;
- repeated whole-handler execution.

The deployment contract permits one all-role Backend process or multiple
same-image API/Gateway/Worker processes, plus one authenticated Agent process
per host. PostgreSQL owns commands, attempts, claims, outbox, observations, and
monotonic Agent session generations; a stale Gateway generation cannot publish
new evidence. A host-global abstract Unix listener remains a kernel-lifetime
Agent lock: a second process is rejected atomically and SIGKILL leaves no stale
lock file. Agent hello includes a fingerprint derived from the host machine
identity; Backend binds it to the server and rejects a credential reused from a
different host. The nyabase Docker daemon and Unix socket are dedicated to this
Agent; another root process mutating that socket is outside the supported fault
model. The deployed Agent unit uses `Restart=always` and
`KillMode=control-group`.

If Agent never connects, a normal never-dispatched task expires as a proved
no-effect failure after its bounded queue lifetime; unstarted reconciliation
and safety work may remain pending because it has made no physical effect. Once
any send may have occurred, an unanswered or repeatedly incomplete task has a
bounded uncertainty window. Exhaustion terminalizes the same task, retains its
locks, and quarantines the Server rather than guessing the physical outcome.
Database loss, malicious Agent behavior, unrecoverable host storage corruption,
and multi-Backend coordination are explicit non-goals.

## 5. Backend durable model

`agent_tasks` is the only execution record:

```text
id                  text primary key
kind                text not null
server_id           text not null
resource_type       text not null
resource_id         text not null
requested_by        text null
request_json        text null
payload_json        text not null
payload_hash        text not null
admission_class     text not null       # normal|reconciliation|safety
status              text not null       # pending|succeeded|failed
agent_result_json   text null           # immutable evidence
result_json         text null
error_json          text null
failure_stage       text null            # dispatch|agent|finalizer
dispatch_attempt_count integer not null
incomplete_result_count integer not null
retry_window_started_at datetime null
next_dispatch_at    datetime null
finalizer_attempt_count integer not null
finalizer_retry_at  datetime null
last_sent_at        datetime null
created_at          datetime not null
started_at          datetime null
completed_at        datetime null
```

The small resource-lock table remains. Locks have no lease or expiry and are
released only by a successful or managed-failure terminal transaction.
Quarantined terminal tasks deliberately retain them. A pending task for an
offline Agent is a valid waiting state, not a fabricated outcome.

## 6. Backend lifecycle

### Enqueue

One serialized transaction validates and encrypts the immutable payload,
inserts the pending task, acquires resource keys, and applies domain
`activeTaskId` bookkeeping.

### Dispatch

One periodic loop plus connect wake sends pending tasks to online Agents. It
updates `startedAt` and `lastSentAt` before sending. Send failure or Backend
restart leaves the task pending and causes the same identity to be sent again.

Admission stays deliberately small: `safety` work is selected before
`reconciliation`, which is selected before ordinary `normal` work. A normal
task that was never sent expires after 15 minutes as a proved no-effect
failure. Reconciliation and safety tasks do not expire merely because they
waited offline or behind cleanup work. After a send, ordinary ambiguity is
bounded by 12 incomplete results or 45 minutes from the retry epoch;
quota and explicitly unsafe shared-quota ambiguities fail closed immediately.
Exhaustion atomically marks the task failed, quarantines the Server, and retains
every lock for explicit same-task retry.

One dispatcher pass selects at most one task for each online Server, and the
first Server rotates between passes. Within a Server the three admission
classes retain strict priority and FIFO ordering. A task deferred by a
temporary payload/network gate yields for at least two seconds, allowing the
next due task in that priority lane to progress. This does not create parallel
physical execution: a bounded duplicate-owner probe and a transaction-time
recheck permit exactly one sent-but-unanswered task per Server; duplicate
durable owners quarantine the lane instead of being guessed away.

Startup validates only pending rows which still need physical dispatch. A
staged Agent outcome belongs exclusively to the database finalizer and does
not require its old encrypted wire payload. If an immutable payload is corrupt
before any send was attempted, Backend records a proved no-effect dispatch
failure and finalizes the domain projection without decoding that payload. If
any send may already have occurred, Backend fail-stops instead of releasing the
lock or dispatching an overlapping intent.

### Result

The authenticated socket server must match `task.serverId`; `payloadHash` must
match the immutable payload.

Agent evidence is first stored durably while the task remains `pending`; the
dispatcher excludes such rows from physical redelivery. Backend then applies
the finalizer in a separate serialized transaction. This closes the window
where Agent completed the effect but a Backend-only finalizer error could
release the lock with stale domain state.

If a finalizer fails, its transaction rolls back completely. The task remains
pending, retains the resource lock and immutable Agent evidence, exposes the
latest finalizer error, and is retried by one small Backend finalization loop.
It never re-dispatches the physical effect. Retries use bounded exponential
backoff and stop after 12 attempts. Exhaustion atomically marks the task failed,
quarantines the Server, and retains the evidence and locks; an administrator
repairs Backend state and retries the same task, which resumes only the
database finalizer. No physical retry or separate attempt table exists.

The immutable wire payload and public request metadata are each capped at
1 MiB, and terminal Agent evidence is capped at 64 KiB on both sides. Agent
constructs a bounded fallback failure when a handler returns oversized or
cyclic evidence; Backend independently validates canonical encoded size and
quarantines malformed evidence. History list endpoints select summaries only;
the single-task endpoint is the only API that materializes complete
request/outcome evidence.

After the immutable Agent outcome is durably accepted, Backend sends
`task.accepted.v1`. This message is only an in-memory ordering barrier: it tells
the current Agent process that no earlier duplicate execute message may require
the cached result. It is not a durable acknowledgement protocol and does not
wait for finalization.

Agent may also report `status=incomplete` with its latest error when a timeout,
ambiguous external result, or partially-started destructive operation cannot
be safely called success or failed-managed. For an ordinary task Backend stores
the diagnostic, keeps all locks, applies bounded backoff, and sends no accepted
message; the same task is re-run from actual state until it converges or reaches
the uncertainty bound. A quota or explicitly unsafe shared-quota ambiguity
instead terminalizes and quarantines immediately. The persisted task status
enum remains only `pending|succeeded|failed`.

### Capacity, retention, and admission

All queues that can outlive one synchronous stack have both local and product
bounds. Important limits are:

| Boundary | Hard bound and overload behavior |
| --- | --- |
| Durable task admission | normal pending: 1,024/Server and 4,096 global; reconciliation: 2,048/Server and 8,192 global; safety: 1,024/Server inside 3,072 total/Server. Seven-day creation windows cap normal/reconciliation/all work at 4,096/8,192/16,384; 262,144 rows is the absolute fail-closed storage limit |
| Agent WebSocket | 8 initializing connections; 8 MiB queued inbound per Server and 64 MiB global; 2 MiB outbound buffer and 64 pending RPCs per admitted session |
| Console | 64 sessions global, 8/user, 16/Server; 32 initializing sockets; 64 concurrent durable authorization reads; 128 KiB/64-frame input backlog and 256 KiB browser output buffer |
| Logs | 256 Ki characters/session and 16 Mi characters global; 256 listeners global and 64/Server |
| Proxy controls | 4 SSH and 4 HTTP proxy clients including initialization; snapshots remain within their 4 MiB and 8 MiB protocol envelopes |
| Agent transient execution | 16 tracked durable tasks; 16 interactive exec sessions; 128 KiB/256-chunk pending exec input; 256 KiB Docker stdin buffer; 1 MiB management-exec output |

Global Agent ingress pressure revokes routes and reconnects the scoped session;
it is not durable evidence that the host is corrupt. A per-Server authenticated
queue violation is instead an Agent protocol fault and quarantines that Server.
Slow console/proxy/log consumers are terminated locally and cannot quarantine
an otherwise-correct Agent.

An initializing or admitted slot is released only when its actual asynchronous
work settles. Socket close and logical timeout do not free a reservation while
an uncancellable database or proxy-snapshot build is still running. Console
authorization is single-flight per session and globally bounded. It rechecks,
in one current PostgreSQL statement, active user status,
container/server/runtime identity, active lifecycle, and either exact ownership
or the live `ManageContainersAny` capability. Agent-side process admission also
locks the durable IAM policy/user/container fence until synchronous dispatch.
Revocation removes the identity-matched session and sends `execClose`
immediately instead of waiting for a WebSocket close handshake.

Terminal history is retained for at least seven days. The retention worker
uses bounded PostgreSQL keyset scans and indexed JSONB predicates rather than
loading legal-size request payloads. It never deletes a row that owns a resource claim,
current domain projection, same-task retry authority, or current image cleanup
generation proof. Startup, exhaustion, finalizer, supersession, cleanup, and
quarantine retry scans likewise fetch bounded IDs or small projections first
and load at most one complete task at a time (eight for explicit retry).

## 7. Stateless Agent runner

Agent has no `stateDir`, `tasks/*.json`, SQLite journal, durable result replay,
or checkpoint recovery.

The runner keeps only transient memory:

- one FIFO for durable high-level tasks;
- one in-flight promise per `taskId`;
- one terminal result per task until matching accepted message or connection
  reset.

Repeated execute messages in one connection share the same promise/result.
After Agent restart the memory is empty; Backend resend invokes the whole
handler again. After connection reset, an unaccepted task is safe to re-run
because its handler is a convergent ensure operation.

A fresh Agent process first performs one unconditional local rollback before
opening an event listener or Backend WebSocket. It re-proves the configured
storage identity, acquires the host-stable physical-mutation fence, stops the
dedicated Docker daemon and proves its service cgroup empty, reconciles that
daemon, then performs two bounded inventories of all managed containers. Every
returned container is addressed by its complete Docker ID, unpaused if needed,
stopped with `SIGKILL`, and freshly observed `Running === false` or absent.
The second inventory also catches a runtime recovered while dockerd was
starting. More than 64 managed containers fails closed instead of creating an
unbounded startup scan.

This rollback uses no Agent journal and makes no durable desired-state
decision. It intentionally stops even desired-running containers, including
while Backend is offline. Once Backend reconnects, the first authoritative
report observes the stopped canonical runtimes and ordinary durable
reconciliation tasks restore every `powerIntent=running` runtime. A startup
read/proof failure exits before WebSocket admission; an ambiguous Docker
mutation fail-stops without releasing its Promise. The next systemd-managed
Agent process repeats the entire proof. A successful proof is single-flight
for that process, so an ordinary Backend reconnect does not stop containers
again.

Before a replacement connection sends hello, Agent joins all older bootstrap
and physical-lane work. An old-generation result may be discarded with its dead
transport, but old work cannot overlap the new session; Backend then redelivers
the same immutable ensure. Authoritative reports use that same serialized lane.
The initial authoritative report must pass a 5-minute readiness gate before
dispatch starts. Once the session is dispatch-ready, the 35-minute steady-state
report watchdog exceeds the 30-minute image-pull deadline plus the bounded
inventory collection budget.

The message router still separates durable high-level tasks from the narrow
interactive control path: exec stream/input/resize/close plus exact read-only
runtime inspection and self-check. Stats and inventory arrive through bounded
Agent reports; there is no public direct stats or generic command RPC.

Interactive exec ownership is transient but physically fenced. Backend first
commits a lifecycle task, then revokes matching consoles and sends
`execClose`; at Agent, an exact-runtime task fence closes and joins any active
or opening exec before the task handler starts and rejects later opens until
handler verification finishes. This covers close/task message reordering and
loss. Stream end, error, explicit close, stdin overflow, and connection reset
share one completion barrier: a trustworthy natural exit requires fresh
`exec.inspect` with `Running=false` and an integer exit code; otherwise Agent
stops and freshly proves the exact container stopped/absent. A Docker mutation
whose outcome is ambiguous fail-stops without reporting EOF or releasing the
runtime owner.

Agent startup may create regenerable assets under `/run/nyabase-agent`, such as
the embedded mount helper and SSH binaries. They disappear on reboot and never
carry task or desired-state data. Docker objects, mounts, XFS metadata, and data
directories are managed resource state, not Agent recovery state.

Every unary Docker observation uses an AbortSignal-backed physical deadline.
When list, inspect, info, ping, stats, or exec inspection times out, the
dockerode Unix-socket request is aborted before a periodic report/metrics retry
may begin. Docker mutations keep the separate fail-stop/physical-barrier
contract; a caller-side timeout is never treated as cancellation or safe
replay. In particular, management `exec.create`, `exec.start`, resize, and the
container-kill barrier never use the abortable-read helper: a missing definite
HTTP response fail-stops the Agent and leaves the call non-returning. Interactive
resize retains one in-flight Docker request plus only the
latest desired size, and stdin overflow/backpressure closes the exec rather
than accumulating writes.

## 8. Handler contract

```ts
interface AgentTaskHandler<Payload, Result> {
  readonly kinds: readonly AgentTaskKind[];
  ensure(kind: AgentTaskKind, payload: Payload): Promise<Result>;
  verify(kind: AgentTaskKind, payload: Payload, result: Result): Promise<void>;
}
```

Every handler must obey all of these rules:

1. Validate the complete payload before the first side effect.
2. Probe the actual resource before every conditional mutation.
3. Give newly-created resources their stable Backend resource ID at creation.
4. Re-entry after every awaited mutation must converge instead of duplicate.
5. `verify` must read actual state; a successful command return is insufficient.
6. Do not start background mutation that can continue after a failed task.
7. Never persist the payload, result, secret, desired spec, or checkpoint.
8. If an effect is not naturally idempotent, carry a Backend-owned observation
   baseline in the immutable task payload.

Validation/programming errors produce explicit failure without a side effect.
An ordinary operational error is managed-terminal only if a fresh probe proves
a typed, addressable state safe to expose. A timeout or ambiguous result
produces `incomplete`, so a late external completion remains owned by the same
task and lock until the bounded uncertainty policy either converges or
quarantines it. Quota/shared-quota incomplete outcomes and non-coordination
safety-task terminal failures quarantine immediately. Destructive operations
such as recursive directory deletion roll forward until their absence
postcondition is observed.

## 9. Task semantics

| Task | Stateless convergence rule |
| --- | --- |
| `container.create` | Find by stable container label; create only if absent; ensure running, quota paths, mounts, and SSH; verify all |
| `container.start` | Start only if stopped; ensure mounts/SSH; verify running |
| `container.stop` | Stop only if running; verify stopped |
| `container.restart` | Compare actual `StartedAt` with Backend-owned baseline; restart only if unchanged; verify it changed and is running |
| `container.delete` | Remove if present; verify absence |
| `container.runtime.absent` | Inspect one exact runtime ID; require the reported managed/server/container/generation/spec-hash labels before every mutation; stop/remove and verify absence |
| `container.ssh.ensure` | Reconcile enabled/key generation; inspect and verify |
| `datadir.ensure` | Create if absent, enforce ownership/quota, verify directory |
| `datadir.absent` | Remove if present, scrub quota path mapping, and remain incomplete until absence is verified |
| `remote_fs.ensure` | Inspect mount table, preserve matching mount, replace mismatch, verify source/options |
| `remote_fs.absent` | Unmount if present, verify absence |
| `quota.ensure` | Set desired hard limit and read it back |
| `image.ensure_present` | Inspect first, pull only if absent, inspect again |

Container creation is still one task. Quota preparation, Docker create/start,
writable-layer quota, mounts, SSH, and verification are ordinary local calls,
not durable steps.

Container creation writes both the durable desired generation and a hash of the
complete immutable runtime specification into Docker labels. The generation is
part of the hash input; it is not a protocol-version constant. Re-entry must
find exactly one runtime for `containerId` and verify both values before
adopting it. Zero matches means create; one exact runtime means continue;
duplicates or a mismatch produce a managed failure instead of selecting an
unrelated runtime.

Every successful full state report is authoritative inventory. Backend keeps
only the lifecycle-bound runtime ID whose generation and spec hash match as the
canonical runtime. Unknown, foreign-server, and duplicate extras
become `container.runtime.absent` tasks carrying the exact reported labels;
repeated reports coalesce behind container and runtime resource locks. If an
Active lifecycle has no canonical runtime, Backend records
`failed/runtime_missing` in the same serialized reconciliation instead of
leaving an in-memory drift flag. A canonical power mismatch becomes an
ordinary durable start/stop task; unsupported power states become an explicit
failed lifecycle. A transitional lifecycle with no active durable task owner
also becomes explicit `failed/runtime_lifecycle_owner_missing`; it cannot stay
permanently busy.

Container inventory carries physical evidence only: `runtimeId`, `ip`,
`serverId`, `specGeneration`, and the two canonical writable-layer
`quotaPaths`, plus status, SSH observation, and exactly the five immutable
identity labels (managed, container ID, server ID, spec generation, runtime
spec hash). Desired product fields such as name, owner, image, CPU, memory,
GPU, mounts, and creation time never cross this Agent-to-Backend wire; Backend
resolves them from its durable model. Container statistics are emitted only as
bounded metrics batches and are not part of authoritative inventory. A Docker
image-list failure invalidates the entire inventory report, emits one bounded
`inventoryFault`, and retires that connection generation instead of silently
reporting an empty image set. Runtime IP is read only from the exact managed
Docker network through fresh inspect results, must be a canonical usable host
inside the Server's bound macvlan CIDR, and must remain stable across capture;
an IP or power-state transition during SSH observation invalidates the report.

Every error-capable Docker call is followed by a fresh inspect. If the target
postcondition is already true, the task succeeds even when the client call
timed out. Otherwise the result is incomplete or a typed managed failure; a
generic exception string is never sufficient evidence for terminal failure.

## 10. Stateless restart baseline

Restart is the only event-like task. Backend obtains a read-only runtime probe
immediately before enqueue and stores `baselineStartedAt` in the immutable
restart payload. The probe performs no effect, so a timeout or Backend crash
before enqueue is harmless.

On every delivery Agent inspects the container:

- if current `StartedAt` equals the baseline, execute restart;
- if it differs and the container is running, the requested target is already
  satisfied;
- verify the container is running and `StartedAt` differs from the baseline.

No clocks, Agent checkpoint, task phase, or generic step table are required.
Restart therefore requires Agent online for the initial read-only probe. Once
the task is enqueued, later disconnection is recoverable.

The same narrow probe captures container graph quota paths before a delete.
Those paths and the numeric owner ID are immutable fields of the delete task,
so a retry can scrub XFS project mappings even after Docker has already removed
the runtime. This is task input, not a generic checkpoint mechanism.

## 11. Partial container creation

If Agent crashes, Backend keeps the task pending and sends it again. The handler
starts from its first line and discovers completed effects through stable
labels and actual state. It does not resume a numbered step.

If the handler returns an explicit failure, Backend marks the lifecycle failed.
It does not automatically delete the canonical container. Any extra runtime
that appears in an authoritative report is removed only through the exact
identity-fenced `container.runtime.absent` task; the Agent never guesses by
name or a broad label query.

The same rule applies to mounts, directories, quotas, and RemoteFS: partial
state is either the requested resource identity or is reported as drift. After
a managed failure, a new ensure intent continues from it and an absent intent
removes it. After a quarantined failure, only the same retained task may be
reopened until it reaches a verified terminal projection.

## 12. RemoteFS bootstrap without Agent registry

Delete `remote-fs-registry.json` and all load/persist/recovery code. Agent keeps
active RemoteFS specs and credentials only in memory while the process runs.
Health checks may report drift but must not launch an unowned background retry.
Mount/unmount verification reads a fresh mount table rather than a time-cached
snapshot.

On each Agent session Backend enters a transient readiness gate before exposing
the session to the task dispatcher. Backend sends one authoritative
`agent.bootstrap.v1` snapshot containing all active RemoteFS assignments. Agent
validates the entire identity/path set, replaces only its transient in-memory
working set, probes the mount table, and returns an `AgentBootstrapResult`
through `commandAck`. Bootstrap performs no mount or unmount effect.

A structurally exact bootstrap response opens only the next readiness gate.
Backend then requires a fresh authoritative full report before dispatch. Missing
or mismatched mounts in that report become ordinary durable
`remote_fs.ensure` tasks. If a running container consumes a mount that needs
repair, Backend first creates a safety-class container stop task and defers the
repair until the consumer is observed stopped. DataDir and container mount
operations remain excluded by the same physical source locks and fresh
mutation-boundary mount checks.

Readiness failures have two explicit classes. Socket loss during bootstrap is
not inventory evidence: the session stays unready and a later connection
repeats the handshake. A still-connected Agent that rejects the authoritative
snapshot, returns structurally invalid identity, or later reports invalid
authoritative inventory instead durably quarantines the Server; reconnect alone
cannot loop past that fault. The 15-minute bootstrap RPC deadline, 5-minute
initial-report readiness gate, and 35-minute steady-state report watchdog also
bound stalled sessions without treating transport loss as physical success.

Bootstrap is a restart-safe connection handshake, not a durable workflow or a
second user mutation API. Backend restart/reconnect sends the same desired
snapshot again; Agent re-adopts it and re-probes without mutation. User-requested
assign and unassign operations, and reboot recovery of missing mounts, use
ordinary AgentTasks and resource locks; physical mount specifications are
immutable while assigned and there is no separate remount path.

The snapshot also rehydrates RemoteFS-backed DataDir sources before pending
tasks enter the Agent FIFO. Same canonical `hostMountPoint` values are rejected
in Backend, and every RemoteFS, DataDir, and container-mount mutation shares the
same physical `mount_source` lock key.

Readiness is rechecked at the mutation boundary, not trusted forever. Before a
DataDir ensure or absent handler reads a child path, Agent verifies that the
configured source root is still an exact mount point of the expected filesystem
type; RemoteFS additionally verifies the full bootstrapped source identity. If
the backing mount disappeared, the task returns `incomplete` and retains its
lock. An exposed empty mount directory can therefore never be mistaken for a
successfully deleted data directory.

DataDir locks also follow physical identity, never user identity. Local
directories use `(server, local source, name)`; a directory on a shared
RemoteFS uses `(remote source, name)` across every assigned server. Matching
partial unique indexes in the fresh schema enforce the same rule after task
finalization.

Removal tasks carry the complete expected source/options/params so an Agent with
empty memory can fail closed instead of unmounting an unrelated filesystem.
If a mount or unmount command returns and a fresh probe proves a stable mismatch,
Agent returns typed managed-failure evidence; if the probe itself is unavailable,
the result remains incomplete. This prevents both infinite retries of a known
conflict and false terminal failures from an ambiguous observation.
Ceph keyrings are transient `/run` material and are deleted in `finally` after
the mount syscall.

Bootstrap cannot be called by user APIs and never stores its snapshot or
credentials. There are exactly two non-task physical convergence paths:
fresh-process Docker rollback described above, which is an unconditional safe
state rather than desired-state execution, and static macvlan convergence
inside Backend-granted bootstrap. The RemoteFS snapshot portion remains
observation-only. Every desired resource change and every post-report recovery
still uses an ordinary durable AgentTask.

## 13. Recovery matrix

| Cut point | Recovery and steady state |
| --- | --- |
| Backend commits task before send | pending scan sends it |
| Execute is lost | resend runs same ensure |
| Duplicate execute arrives while running | in-memory promise deduplicates |
| Duplicate execute was sent before outcome acceptance | cached result is returned until accepted |
| Agent dies before effect | resend starts from actual state |
| Agent dies during effect | resend probes partial state and converges |
| Agent process restarts, including while Backend is offline | before any WebSocket, the replacement fences old mutation helpers, reconciles the dedicated daemon, and stops/fresh-proves every managed container; no old interactive or management exec can survive into new admission |
| Replacement dies during local Docker rollback | no readiness is advertised; systemd starts another process and the same idempotent full rollback repeats |
| Startup rollback stops a canonical desired-running runtime | first authoritative report preserves Backend `powerIntent=running`; RuntimeDriftReconciler enqueues an ordinary durable `container.start` task with exact runtime/quota/mount identity |
| Effect completes before result | resend verifies and returns success |
| Result is lost | Backend remains pending and resends |
| Backend dies before result transaction commit | Agent reconnect/resend repeats ensure |
| Backend accepts outcome before accepted message | physical redispatch stops; duplicate result receives accepted again |
| Finalizer fails | transaction rolls back; stored evidence remains pending/locked and the Backend-only finalizer retries; attempt 12 terminalizes/quarantines with evidence and locks retained for same-task finalizer retry |
| Normal task waits 15 minutes without any send | Backend records proved no-effect failure and finalizes/releases its locks |
| Reconciliation/safety task is never sent | it remains pending/locked because no physical attempt is ambiguous |
| Agent never returns after a send | 45-minute retry epoch expires, or 12 incomplete results accumulate; task fails, Server quarantines, and locks remain for same-task retry |
| Agent restarts with active RemoteFS assignments | observation-only bootstrap rehydrates transient identity; the first full report schedules durable recovery tasks before unsafe consumers may proceed |
| Source mount disappears before DataDir delete | fresh source guard returns incomplete; no child deletion or metadata finalization occurs |
| Socket disappears during hello/bootstrap | server remains unready and reconnect repeats initialization without inferring inventory corruption |
| Connected bootstrap or authoritative inventory is invalid | Server durably enters inventory quarantine; reconnect cannot bypass explicit repair/retry |
| A unary Docker observation never responds | its AbortSignal closes the physical Unix-socket request at the read deadline; the coalesced report/metrics job may retry without accumulating old sockets |
| Interactive exec transport ends or its close outcome is ambiguous | natural success requires fresh stopped exec plus integer exit code; otherwise the exact container is stopped/fresh-proved, or Agent fail-stops without EOF/owner release |
| A lifecycle task races an interactive exec | Backend commits the durable task before sending close; Agent's exact-runtime fence joins active/pending close before handler execution and blocks later opens through verification |
| Console user/capability/container/runtime authority is revoked | the next in-flight/periodic check observes one current DB snapshot, identity-removes the session, sends `execClose` immediately, and rejects further input |
| Socket closes while DB authorization or initial proxy snapshot is running | transport closes, but the bounded initializing slot remains reserved until the uncancellable work actually settles |
| Global Agent ingress capacity is reached | routes are blocked and that session reconnects; Backend load alone does not create a durable host quarantine |
| Durable task admission reaches a rolling/hard bound | the enqueue transaction fails before task/lock creation; safety work retains its reserved admission class but remains subject to per-Server, rolling, and absolute hard bounds |

## 14. Required deletion

Delete rather than alias:

- Agent `task-store.ts` and all store/checkpoint/result-replay tests;
- Agent `stateDir` configuration and deployment examples;
- RemoteFS registry path, load, persist, and startup recovery;
- checkpoint methods and `saveCheckpoint` handler context;
- persisted-running/terminal protocol assumptions;
- any background RemoteFS mutation retry not owned by a pending Backend task;
- old Operation/Attempt/Step/WorkItem/V6 paths already removed by the previous
  clean cutover.

Replace `task.commit.v1` with `task.accepted.v1` for transient same-session
ordering. It must never cause a file or database write on Agent.

## 15. Conformance and acceptance

The guard must fail if Agent source or deploy configuration contains:

```text
AgentTaskStore
TaskRecord
stateDir
remote-fs-registry
loadRegistry
persistRegistry
recoverPersistedMounts
saveCheckpoint
tasks/<taskId>.json
better-sqlite3
task.commit.v1
```

Required tests include:

- every task kind is safe to execute twice against the same observed state;
- Agent restart with no writable recovery directory converges after resend;
- fresh Agent startup stops and freshly proves every managed runtime before
  opening a Backend socket, retries the whole rollback after process death,
  and does not repeat it on ordinary reconnect;
- desired-running runtimes stopped by startup rollback are restored only by a
  durable Backend reconciliation task after an authoritative report;
- result loss and Backend restart cause re-ensure, not duplicate resources;
- same-session duplicates return one cached terminal outcome until accepted;
- restart uses only Backend baseline and actual `StartedAt`;
- container create crash windows never create two labelled runtimes;
- explicit create failure leaves a visible/deletable failed runtime;
- RemoteFS process restart rehydrates through the readiness snapshot without a
  registry file or persisted secret;
- RemoteFS mount/unmount uses fresh probes and never mutates after task failure;
- bootstrap blocks normal task dispatch until the exact RemoteFS identity set is
  adopted and the first authoritative full report is processed; any mount repair
  is represented by durable recovery/safety tasks;
- DataDir mutation refuses an unavailable or wrong backing mount before treating
  any child path as present or absent;
- bootstrap transport loss closes the socket and re-enters the bounded reconnect
  path, while authoritative bootstrap/inventory faults durably quarantine;
- duplicate/mismatched container labels and spec hashes fail closed;
- ambiguous/timeout results remain pending and locked only within the retry
  bound, then terminalize in quarantine without releasing authority;
- physical lock keys match canonical mount/data-directory identity;
- SSH disable verification, remote ownership/quota verification, KiB quota
  normalization, image-pull timeout probing, and XFS path scrubbing pass;
- finalizer, terminal task, active state, and managed lock release remain
  atomic; exhausted finalizers retain evidence/locks and retry only the
  database projection;
- repeated Docker read timeouts abort their real Unix sockets and cannot grow
  live requests across periodic metrics/report runs;
- owner/admin Console authority is rechecked at claim and during use; disabling
  a user, changing container/runtime identity, or revoking
  `ManageContainersAny` immediately sends `execClose` and rejects input;
- task/console reordering, pending exec open, stream error without close,
  ambiguous close, and Agent restart cannot release an exec owner before a
  fresh physical absence proof;
- admission-close races retain their initializing slot until uncancellable DB
  or snapshot work settles, and every aggregate buffer/queue limit has an
  explicit overload test;
- fresh migration, full checks, Common source cleanliness, and standalone Agent
  binary pass.

## 16. Delivery order

1. Freeze this design and its steady-state/fault matrix.
2. Simplify Agent runner to transient memory and remove Agent stores/config.
3. Remove handler checkpoints; make every handler whole-task idempotent.
4. Add Backend restart baseline probe and RemoteFS session rehydration.
5. Remove RemoteFS registry/background mutation and update deployment/docs.
6. Add deterministic crash, duplicate, partial-effect, and rehydration tests.
7. Run conformance, migration, binary, full repository, and relevant browser
   verification before declaring the goal complete.
