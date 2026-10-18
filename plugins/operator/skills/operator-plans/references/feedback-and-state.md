# Feedback, versioning and completion semantics

| Fact | What it establishes |
| --- | --- |
| User report | The person's stated `done`, `failed`, `cannot-find` or `unclear` experience |
| Agent report | What an agent observed or performed through an authorized tool |
| Execution receipt | The server-recorded action, execution state, time and sanitized output |
| Independent verification | The expected postcondition checked against its actual authority |
| Acceptance | The required criteria and any explicit human decision are satisfied |

Do not infer one row from another. `operator_mark_step` retains user-report semantics; an output checkpoint or a zero exit status does not establish all acceptance criteria.

## Resume and concurrent edits

Read current plan and step state before writes. Preserve `payload.values`, earlier outcomes, comments, attachments and execution records, including failed attempts. Use the returned integer plan version as the compare-and-set value. On conflict reload, preserve local work and reconcile; do not overwrite a newer version automatically.

Use stable request IDs on operations that support them. Retry an uncertain idempotent write only with the identical operation and payload. For legacy calls without an idempotency key, inspect saved state before considering repetition. Read both version and event cursors: a comment can append feedback without incrementing the plan version.

Record a nonsecret explanation when a step fails or is unclear, inspect evidence, and revise only the affected instructions. Keep the same canonical plan link. Do not silently convert failure into completion or erase earlier results.

Project projections retain the original human source status and version. Complete or rework the human source through its original plan; project task writes cannot synthesize its lifecycle. A complete human workflow node must agree with its canonical source step.

Operator is authoritative for its saved task, step, input, acceptance and execution records. Source control and connected systems remain authoritative for their own code and runtime facts. Caller summaries or claimed identities never override those authorities.
