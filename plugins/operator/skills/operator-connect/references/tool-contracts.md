# Connection contracts — 1.3

Discover these tools on the connected server; this document does not establish which release is deployed.

| Tool | Inputs | Purpose |
| --- | --- | --- |
| `operator_get_capabilities` | None | Authenticated feature flags, including whether Events delivery is available |
| `operator_capabilities` | None | Plan fields, templates, registered action contracts and the authoritative Operator origin |
| `operator_profile` | None | Validated connection identity; use only fields actually returned |
| `operator_list_blocks` | None | Available field, step, template and registered action building blocks |
| `operator_list_projects` | None | Projects, linked human plans and independent plans |
| `operator_list_plans` | Optional `project` | Existing human plan summaries |
| `operator_home` / `operator_thread` | None | Native management entrypoints when supported by the host |
| `operator_search_objects` | Optional `query`, `limit=25`, `cursor=""` | Search bounded object results |
| `operator_search_mentions` | Optional `query`, `limit=20` | Search supported mention context |
| `search_mentions` | `query` | Host-native mention search when the host exposes its app-only entrypoint |
| `operator_open_file` | Host-provided `file` metadata | Resolve an opaque supported file reference; does not open an arbitrary filesystem path |
| `operator_request_form` | `plan_id` | Collect a typed review response; grants no execution permission |
| `operator_read_settings` / `operator_update_settings` | Read: none; update: `values`, optional `layout` | Existing app preferences |
| `operator_native_settings_read` / `operator_native_settings_update` | Read: none; update: host schema's `set` | Native preferences when exposed by the host |

## Navigation and capability boundaries

Use canonical links returned by Operator. If a result provides only its Operator origin and a known plan ID, construct a URL with URL-encoded `plan` and, when relevant, `step` query parameters; preserve an authoritative project association. The destination is the original human steps view. Native panels provide discovery, summaries, workflows and results; human editing and protected actions use that canonical view directly.

Use only exposed tool names and current schemas. If a host lacks panels, read structured tool results and provide the same canonical link. If it lacks Events, resume through explicit reads; do not claim the chat wakes itself. `operator_get_project_runtime` reports project worker processing separately from an autonomous LLM runtime.

Keep existing connection identity, audience, scopes and app binding. A cached UI resource, successful installation or skill import is not evidence that the server changed or a user completed an action. Caller context never overrides authenticated server identity, state, versions, receipts or permissions.
