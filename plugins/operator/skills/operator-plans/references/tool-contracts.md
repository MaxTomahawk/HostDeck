# MCP tool contracts — 1.3

Read the connected server schema before use. These required-argument summaries preserve existing tools and do not establish which release is deployed.

| Tool | Required inputs | Effects |
|---|---|---|
| `operator_add_comment` | plan_id, text | write |
| `operator_add_comment_once` | plan_id, request_id, text | write |
| `operator_archive_plan` | plan_id, expected_version, request_id | write |
| `operator_begin_evidence_upload` | plan_id, filename, mime_type, size_bytes, request_id | write |
| `operator_complete_evidence_upload` | upload_id, sha256 | write |
| `operator_create_plan` | request_id, title, project, summary, purpose, impact, payload | write |
| `operator_create_plan_once` | request_id, title | write |
| `operator_create_step` | plan_id, expected_version, request_id, step | write |
| `operator_get_changes` | plan_id | read |
| `operator_get_evidence_metadata` | attachment_id | read |
| `operator_get_plan_summary` | plan_id | read |
| `operator_get_plan_values` | plan_id, step_key | read |
| `operator_get_step_detail` | plan_id, step_key | read |
| `operator_list_evidence` | plan_id | read |
| `operator_list_plans` | {} | read |
| `operator_mark_step` | plan_id, version, step_key, outcome | write |
| `operator_open_plan` | plan_id | read |
| `operator_patch_step` | plan_id, step_key, expected_version, request_id, changes | write |
| `operator_read_evidence` | {} | read |
| `operator_read_plan` | plan_id | read |
| `operator_restore_plan` | plan_id, expected_version, request_id | write |
| `operator_search_plans` | {} | read |
| `operator_update_plan` | plan_id, version, title, project, status, template_id, summary, purpose, impact, payload | write |
| `operator_update_plan_draft` | plan_id, step_key, expected_version, request_id, values | write |
| `operator_upload_evidence_chunk` | upload_id, offset, data_base64 | write |

Only operations with server-enforced idempotency are replay-safe. Keep the original request ID and identical payload after uncertainty. Preview, user reports, registered authority and verified receipts are distinct. Honor protected execution and recovery channel restrictions. Server identity and state remain authoritative; caller context never overrides them.

`operator_read_evidence` requires either `evidence_id` or `plan_id` even though both are optional in its transport schema. Evidence reads are bounded by `offset` and `limit`; uploads are bounded, chunked and completed only after the SHA-256 check. `operator_open_plan` provides a summary with direct links to the canonical human steps view; retained `operator_mark_step` records only an actual user report. Neither a host form nor a report substitutes for portal owner acceptance of a proposed project assignment.
