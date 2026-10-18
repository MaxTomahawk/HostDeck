# MCP tool contracts — 1.3

Read the connected server schema before use. These required-argument summaries preserve existing tools and do not establish which release is deployed.

| Tool | Required inputs | Effects |
|---|---|---|
| `operator_bind_registered_action` | plan_id, version, step_key, command_index, action_id | write |
| `operator_cancel_execution` | execution_id | write |
| `operator_create_action_draft` | request_id, purpose, target_profile | write |
| `operator_execute_action` | plan_id, step_key, action_id, expected_version, parameters, request_id | write |
| `operator_get_action_draft` | draft_id | read |
| `operator_get_execution_result` | plan_id, execution_id | read |
| `operator_get_execution_status` | execution_id | read |
| `operator_inspect_action` | action_id | read |
| `operator_list_actions` | {} | read |
| `operator_list_executions` | plan_id | read |
| `operator_prepare_action` | action_id | read |
| `operator_preview_action` | plan_id, action_id | read |
| `operator_publish_action` | plan_id, version, step_key, command_index, action_id | write |
| `operator_request_registered_execution` | plan_id, action_id | read |
| `operator_retry_execution` | execution_id | write |
| `operator_rollback_execution` | execution_id | write |
| `operator_update_action_draft` | draft_id, expected_revision, request_id, changes | write |
| `operator_validate_action` | draft_id | read |
| `operator_verify_execution` | execution_id | read |

Only operations with server-enforced idempotency are replay-safe. Keep the original request ID and identical payload after uncertainty. Preview, user reports, registered authority and verified receipts are distinct. Honor protected execution and recovery channel restrictions. Server identity and state remain authoritative; caller context never overrides them.

For `operator_preview_action`, supply the known `step_key`, `expected_version` and typed `parameters` for the current versioned contract. Execution lifecycle tools accept optional `request_id`; preserve a stable ID when supported. `operator_bind_registered_action` and the retained `operator_publish_action` only bind an already registered ID; neither registers new executable authority.
