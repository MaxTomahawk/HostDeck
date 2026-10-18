# Human plan shape and canonical navigation

Read `operator_capabilities` and the actual plan before editing. The original renderer and saved step identities remain the human work surface.

```json
{
  "steps": [{
    "key": "account-signin",
    "title": "Sign in to the existing account",
    "status": "pending",
    "goal": "Make the authorized session available.",
    "why": "This step requires the account owner's sign-in.",
    "impact": "No account settings are changed.",
    "target": {"device": "Browser", "url": "https://example.com/sign-in"},
    "instructions": ["Open the verified provider page and sign in with the existing account."],
    "expected": "The expected account dashboard is visible.",
    "technical": "Recovery: sign out if the wrong account is shown."
  }],
  "values": {}
}
```

The example is an authoring pattern, not a real provider target or a created plan.

- Keep unique, stable step `key` values. Do not rebuild already reported steps or create a second copy when linking a plan to a project.
- Keep `title`, `goal`, `why`, `impact`, `expected`, `technical` and target values as text. `instructions` is a list of strings. Keep recovery instructions in text rather than inventing a nested schema.
- Discover supported field types; the established types are `text`, `textarea`, `number`, `select`, `boolean`, `secret` and `url`. A secret declaration is allowed; a secret value is never allowed in an MCP request.
- Nonsecret values belong to `payload.values[step_key][field_key]`. Updating instructions must preserve portal-entered values. `operator_update_plan_draft` replaces only the selected step's nonsecret values with plan-version checking.
- Native human step `depends_on` references stable step keys. Preserve the server's prerequisite and successor projection; do not remove dependencies to force completion.
- Displayed commands have no execution authority. Bind `execution.action_id` only to an ID returned by the connected registry, with its actual binding shape and parameters. Preserve the server's `completes_step` semantics.
- Attachment metadata and captured execution output remain attached to the original plan/step. Upload bytes through the evidence API; a filename or link in metadata is not a completed upload.

## Open the original step

Prefer the server's canonical link. Use its authenticated Operator origin with URL-encoded `plan` and `step` query values only when constructing a link from returned identifiers. Preserve a returned project association. A project task linked by `plan_id` and `step_key` opens that exact original step, including its input, feedback, secret and execution controls. Workflow `node.key` may differ from `node.step_key`; use `step_key` for human navigation.
