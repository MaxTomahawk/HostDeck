# Operator project contracts — 1.3

Discover actual schemas on the connected server before use. This reference describes the prepared 1.3 contract; it does not prove deployment or host synchronization.

## Authority, state and identity

Use server-returned IDs, versions, readiness, input status, source provenance and claim data. Caller context, an `agent_label`, a previous chat summary or an asserted actor cannot override authenticated identity, permissions, receipts or canonical state. All project writes stay within the existing authenticated connection; task coordination does not grant privileged execution or provider access.

Task `state` is one of `backlog`, `todo`, `in_progress`, `in_review`, `done` or `canceled`. It is separate from `next_actor` (`agent`, `human` or `external`), `ready`, `blocked_by`, `input_blockers` and `wait_reason`. Classify agent work by its actual next actor, including tasks with `kind="general"`. Do not count a pending human proposal as an accepted human assignment.

A task read includes its description, goal, expected output, environment, required tools/capabilities, assets, criteria, input location, next action, artifact references, dependencies and successors. Linked human tasks retain `plan_id`, `step_key`, `source_state`, `source_version` and `source_readonly`; their original source controls their lifecycle. Complete or rework them through their original human plan.

## Read tools and pagination

| Tool | Arguments | Result/use |
| --- | --- | --- |
| `operator_list_projects` | None | Projects, associated human plans and independent plans |
| `operator_get_project_graph` | `project_id`, optional `limit=1000`, `cursor=None` | Consistent graph page: project, phases, tasks, edges, plans and canonical links |
| `operator_list_project_tasks` | `project_id`, optional `next_actor=None`, `state=None`, `limit=100`, `cursor=None` | Task page with actual actor/state filters, including canonical human projections |
| `operator_export_project` | `project_id`, optional `limit=250`, `cursor=None` | Export page with `format="operator-project-v1"`, timestamp and canonical references |
| `operator_get_project_task` | `project_id`, `task_id` | Flattened task detail plus `inputs`, latest 200 `checkpoints` and `checkpoints_truncated` |
| `operator_next_project_tasks` | `project_id`, optional `actor="agent"` | Ready `items` and a waiting count |
| `operator_project_changes` | `project_id`, optional `after=0`, `limit=100` | Append-only event `items`; resume after the last returned event ID |
| `operator_list_project_task_checkpoints` | `project_id`, `task_id`, optional `after=0`, `limit=100` | Paged durable progress, handoff, output and blocker records |
| `operator_list_project_task_inputs` | `project_id`, `task_id` | Input `items` and current `task_version` |
| `operator_get_project_runtime` | `project_id` | Actual worker heartbeat, processing state and execution model |

Graph, task-list and export page sizes are 1..2000. Treat `next_cursor` as opaque. Preserve the same project, filters and limit, then follow every page until `next_cursor` is null. Responses include `total_tasks` and `snapshot_id`; a cursor is bound to a consistent snapshot. If the project changes between pages, HTTP 409 requires discarding the accumulated pages and restarting at page one. Retry once or report that the project changed again; never silently combine different snapshots or loop indefinitely.

Graph/export `links` are `{task_id, href}` entries. Use the returned canonical same-origin task or plan/step link. Deduplicate tasks and edges by their stable identities when combining pages. Export completion requires all pages. An export contains coordination data and evidence references; attachment bytes and full checkpoint history require their own authenticated reads.

Event pages accept 1..500 items; checkpoint pages accept 1..200. Their numeric `after` cursors are distinct from opaque graph/task/export cursors. Do not reuse one cursor kind for another.

## Project, phase and task editing

All project mutation `request_id` values are stable strings of 8..128 characters. Generate a new ID for a distinct operation. For an uncertain retry, preserve the original operation and exact payload; conflicting reuse is rejected. Read the current version before constructing a new write.

| Tool | Required arguments | Optional arguments |
| --- | --- | --- |
| `operator_create_project` | `name`, `request_id` | `summary=""`, `description=""` |
| `operator_update_project` | `project_id`, `expected_version`, `request_id` | `name`, `summary`, `description` |
| `operator_create_project_phase` | `project_id`, `title`, `request_id` | `position=0` |
| `operator_update_project_phase` | `project_id`, `phase_id`, `expected_version`, `request_id` | `title`, `position` |
| `operator_create_project_task` | `project_id`, `title`, `request_id` | `description=""`, `kind="general"`, `next_actor="agent"`, `phase_id`, `plan_id`, `step_key`, `metadata` |
| `operator_update_project_task` | `project_id`, `task_id`, `expected_version`, `request_id` | `state`, `next_actor`, `acceptance_note`, `description`, `title`, `metadata`, `lease_id`, `fence`, `phase_id`, `clear_phase=false` |
| `operator_bulk_create_project_tasks` | `project_id`, `request_id`, `tasks`, `edges` | None |
| `operator_add_task_dependency` | `project_id`, `task_id`, `needs_id`, `request_id` | None |
| `operator_remove_task_dependency` | `project_id`, `task_id`, `needs_id`, `request_id` | None |

Use the project version for project editing, phase version for phase editing, and task version for task editing. Project rename preserves associated original human plans and history. To move a task use `phase_id`; to remove its phase use `clear_phase=true`. Do not supply both. Omitting both leaves the phase unchanged.

The task `metadata` object allows only:

- Text: `goal`, `expected_output`, `environment`, `input_location`, `next_action`.
- String arrays: `required_tools`, `capabilities`, `assets`, `acceptance_criteria`, `quality_criteria`, `artifact_refs`.

Use returned live schemas for field bounds. Never put secret values or credentials in metadata. Artifact references are Operator/HTTPS pointers without embedded credentials; persisting a pointer does not prove the referenced content exists, is accessible or was verified.

Bulk creation accepts 1..250 new tasks with stable per-task `key` strings and up to 1000 edges using `task_key` and `needs_key`. Follow the accepted task item schema; do not bulk rewrite or link existing human plans. The server validates project/phase ownership, keys and the full DAG before one idempotent transaction.

A dependency means `task_id` needs `needs_id`. Add/remove use their own idempotent request, without `expected_version`. The server rejects cycles, cross-project links, canonical-source conflicts and disallowed edits to running or completed targets. Do not remove a valid prerequisite merely to unblock completion.

## Claims, fencing and resumption

| Tool | Required arguments | Optional arguments |
| --- | --- | --- |
| `operator_claim_next_project_task` | `project_id`, `request_id` | `agent_label="ChatGPT"`, `lease_seconds=900`, `task_id=None` |
| `operator_renew_project_task` | `project_id`, `task_id`, `expected_version`, `request_id`, `lease_id`, `fence` | `lease_seconds=900` |
| `operator_release_project_task` | `project_id`, `task_id`, `lease_id`, `request_id` | `expected_version`, `fence` |

Claim reserves one ready agent task atomically, optionally the specified task. It returns `{task, lease_id, fence, expires_at}`; `task=null` means no eligible claim, not permission to choose blocked work. A successful claim moves the task to `in_progress` and returns its new version. Lease duration is 60..3600 seconds.

Keep the exact lease ID, fence, expiry and latest server task version. Include `expected_version`, `lease_id` and `fence` with claimed metadata/lifecycle changes, input writes/validation, proposals, rework and checkpoints. Renew before expiry for ongoing work. Renewal returns the task and current lease data. After expiry or invalidation, reread/reclaim before writing agent results; never use an old fence or fabricate a replacement.

Release when safely stopping. The response includes `released`, `task_id` and the updated `task`. Current callers should send version and fence. Older release callers may omit them: the server resolves the exact supplied lease atomically after checking its saved idempotency receipt. An identical original retry remains safe; an expired, missing or different lease cannot release another claimant's work. Do not enrich an uncertain retry with new fields that change its payload.

On resumed work, read task detail, input status, relevant checkpoint history, current dependencies and actual claim state. Confirm earlier external effects against their authority before repeating them. Independent ready tasks may be claimed by separate agents; a human gate blocks its dependent branch.

## Typed inputs and explicit validation

| Tool | Required arguments | Optional arguments |
| --- | --- | --- |
| `operator_set_project_task_input` | `project_id`, `task_id`, `key`, `expected_version`, `request_id`, `definition` | `lease_id`, `fence` |
| `operator_validate_project_task_input` | `project_id`, `task_id`, `key`, `expected_version`, `request_id`, `accepted`, `note` | `lease_id`, `fence` |

An input key matches `[A-Za-z0-9_-]{1,80}`. `definition` allows `label`, `required`, `kind`, `criteria`, `options`, `value` and `validation_actor`. Kinds are `text`, `number`, `boolean`, `url`, `choice` and `artifact`. `validation_actor` is `agent` or `human`. Provide real typed values and accepted choice options. Use the project's input slots only for nonsecret data; secret entry remains in original protected human controls.

Use current **task.version** for both calls, including a new input. An individual input's `version` is its revision evidence, not the task compare-and-set value. Responses return updated flattened task detail; refresh the local task version after each write.

An input records `missing`, `submitted`, `validated` or `rejected`. Submission never validates automatically, and changing a value invalidates its previous validation. Check its actual criteria and evidence before accepting or rejecting with a nonempty note. Required inputs block readiness until validated. For a human validation gate, only the portal owner can validate; an agent cannot perform it, downgrade the validator or remove the required gate.

## Human proposals and canonical work

`operator_propose_project_human_task(project_id, task_id, expected_version, request_id, proposal, alternatives, limitations, expected_quality, benefit, lease_id=None, fence=None)` records a proposal. Each explanation is required: the exact human contribution, available agent/tool alternatives, present limitations, expected quality and the benefit of involving the person.

Creating a human-kind/next-actor task through MCP does not constitute owner consent. It remains a proposal with the agent responsible until the owner explicitly accepts in the portal. An incomplete proposal cannot be accepted. The owner may decline, including an incomplete proposal; that decision does not authorize automatic reassignment. Explicit human task creation by the portal owner can itself record acceptance. Only the authenticated server identifies that channel; caller text cannot claim to be the portal.

Inspect `human_assignment.status` (`none`, `proposed`, `accepted`, `declined`) and `complete`. Never simulate acceptance with a task patch, user-report API, label, checkbox in another host or fabricated outcome. There is no MCP owner-acceptance tool.

For linked existing human plans, use returned `plan_id`, `step_key` and canonical links. Open the original human step directly with its saved inputs, feedback, evidence, secrets and bounded execution controls. Do not route through an AI-chat handoff, duplicate editor or mode selector. Preserve source state/version and do not complete the projection through project lifecycle writes.

## Checkpoints, completion and rework

`operator_record_project_task_checkpoint(project_id, task_id, kind, summary, request_id, artifact_refs=None, expected_version=None, lease_id=None, fence=None)` appends a nonsecret record. Kinds are `progress`, `handoff`, `output` and `blocked`; summary is at most 4000 characters and references at most 20. Include current version and lease/fence for claimed agent work. A blocking checkpoint requires a current task version, and human-source blockers belong in the original plan.

The response is a **checkpoint**, not a task. Read task detail afterward when current task state/version is needed. Records preserve provenance; do not invent actor, channel or lease history. Read paged checkpoint history when `checkpoints_truncated` is true or a prior handoff is needed.

An output checkpoint or artifact reference is a report/pointer, not independent proof of remote content or an immutable execution receipt. Complete a task only when prerequisites and required inputs pass, actual output is available, acceptance and quality criteria are checked, and `acceptance_note` explains the result. Where output/criteria require evidence, supply the actual evidence references and distinguish what was checked from what was reported.

Use `operator_rework_project_task(project_id, task_id, expected_version, request_id, reason, lease_id=None, fence=None)` to reopen ordinary task work explicitly. It clears prior acceptance, records the reason and invalidates downstream claims/results for rechecking. Completed descendants may return to review. Reread the graph and current versions before continuation. Linked human steps are reworked in their original plan.

## Events and actual runtime

`operator_get_project_runtime` reports `worker_last_seen`, processing counts, automatic processing categories and `execution_model="authenticated_agent_claims"`; `autonomous_llm_runtime` is false. The worker processes canonical human projections, input readiness, dependency release, durable events and lease recovery. Notifications and optional host Events do not create an autonomous LLM daemon or guarantee a sleeping chat resumes.

`operator_replay_project_events(project_id, request_id, after=0, limit=100)` requeues a bounded persisted event batch for idempotent workflow recovery; bounds are `after>=0`, `limit=1..500`. Inspect runtime and event history first and keep the stable replay request/payload. This does not dispatch privileged commands or authorize repeating external effects.

Handle failures according to their meaning: 401/403 requires resolving identity/authority, a stale version or lease requires reread/reconciliation, an input/human gate requires its actual authorized action, and an unknown execution outcome requires receipt inspection. None is success and none justifies changing the authenticated actor or bypassing server checks.
