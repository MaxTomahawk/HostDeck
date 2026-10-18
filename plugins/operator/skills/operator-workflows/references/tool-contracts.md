# MCP tool contracts — 1.3

Read the connected server schema before use. These required-argument summaries preserve existing tools and do not establish which release is deployed.

| Tool | Required inputs | Effects |
|---|---|---|
| `operator_cancel_workflow` | workflow_id | write |
| `operator_create_workflow` | plan_id, expected_version, request_id, nodes | write |
| `operator_get_workflow` | workflow_id | read |
| `operator_list_workflows` | plan_id | read |
| `operator_pause_workflow` | workflow_id | write |
| `operator_record_adapter_result` | workflow_id, node_key, request_id, result | write |
| `operator_report_workflow_node` | workflow_id, node_key, request_id, status, agent_report | write |
| `operator_resume_workflow` | workflow_id | write |
| `operator_start_workflow` | workflow_id | write |
| `operator_validate_workflow` | workflow | read |

Only operations with server-enforced idempotency are replay-safe. Keep the original request ID and identical payload after uncertainty. Preview, user reports, registered authority and verified receipts are distinct. Honor protected execution and recovery channel restrictions. Server identity and state remain authoritative; caller context never overrides them.

Lifecycle tools accept an optional `request_id`; inspect the live schema and preserve it across an uncertain retry. `operator_validate_workflow` validates the supplied legacy plan shape and action references; it does not create, start or enforce a durable workflow. Use `operator_create_workflow` and its server state for durable execution. New human nodes require the actual `step_key`; a node report cannot complete a human source that is not done.
