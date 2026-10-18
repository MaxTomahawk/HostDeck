---
name: operator-plans
description: Find, create, edit or resume durable Operator human-action plans with stable step identities, nonsecret inputs, feedback, attachments and evidence. Use for actual account, MFA, device, decision or user feedback gates.
---
# Plans and human steps

Do independent authorized work first. Give the person the exact target, purpose, prerequisites, steps, expected result and recovery. Preserve the existing plan and step keys.

1. Search existing plans and read current summaries, step details, feedback, evidence and execution records before deciding what remains. Server state takes precedence over caller context or a previous chat summary.
2. Prefer `operator_create_plan_once`, targeted step tools and `operator_add_comment_once` with stable request IDs. Read the current version before editing. On conflict preserve the user's work, reload and reconcile.
3. Use `operator_get_plan_values` and `operator_update_plan_draft` for one step's nonsecret values. Preserve all other values, history and attachments. Declare secret fields without their values; protected input stays in the canonical human view.
4. Open the exact plan and step directly in Operator's original steps view using its canonical link. Native plan panels are summaries and links. Do not add an AI-chat handoff, mode switch or duplicate human editor.
5. Keep human reports, agent reports, execution receipts and independent verification distinct. The retained `operator_mark_step` API records only an actual user-reported outcome; never infer completion or use it to bypass project assignment acceptance.
6. For a newly proposed human contribution in a project, use `operator-projects` to explain the agent/tool alternatives, limitations, expected quality and benefit. Only explicit owner acceptance in the portal assigns that proposed work to the human.
7. Archive reversibly. Resume with both plan versions and feedback event cursors, since comments can change without a plan-version increment. Upload evidence with bounded chunks and the required SHA-256 completion check; stored references alone do not verify remote content.

Read [tool contracts](references/tool-contracts.md), [plan shape](references/plan-shape.md), [human interaction types](references/human-step-types.md) and [feedback semantics](references/feedback-and-state.md) as needed. Use `operator-workflows` for durable action chains and canonical human gates.
