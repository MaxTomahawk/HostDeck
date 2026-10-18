# Durable workflow contract — 1.3

Use the exposed `operator_create_workflow(plan_id, expected_version, request_id, nodes)` schema. Do not invent a workflow field on a legacy plan write. Creation and start are separate operations.

A node has a unique `key`, supported `type` (`human`, `action`, `agent_connector` or `verify`) and `depends_on` containing existing node keys. The server rejects cycles and unknown references. Action nodes use registered IDs and accepted typed `parameters`; verification nodes use the supported evidence contract.

## Canonical human steps

Every new human node needs a valid `step_key` in the original plan. Workflow `key` and human `step_key` may differ. Use the original step's canonical link and controls, not a duplicated node editor or AI-chat screen.

Human nodes expose source provenance such as `source_state`, `source_version`, `source_readonly` and their separately recorded workflow status. The worker adopts a canonical `done` result and reevaluates dependencies. A report attempting completion before the source step is done is rejected. Legacy nodes can resolve their key only where it is an actual original step key; never guess a missing association.

## Other results and lifecycle

An action completes from its persisted execution receipt; a report cannot impersonate it. Connector reporting uses `status="reported"` and `agent_report={"type":"agent_report","result":{...}}`. `operator_record_adapter_result` builds that envelope from its `result` argument. Portal acceptance is a distinct decision tied to the stored report.

Reuse the same request ID only with the identical report payload. Conflicting reuse is rejected. Keep workflow and execution IDs across interruptions, reread before further action, and preserve unknown execution states until reconciled.

Start, pause, resume and cancel through supported lifecycle tools. Cancellation does not undo dispatched effects. Compensation requires a separately admitted operation. Optional Events provide notifications; they do not authorize commands or guarantee that an LLM will run.
