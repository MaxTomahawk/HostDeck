# Workflow patterns

## Human sign-in, bounded action and verification

1. Resolve or create the actual human plan step with exact provider target and expected result; never collect MFA codes or credentials in chat.
2. Reference its stable `step_key` from a human workflow node. Open the original human step directly.
3. Add an action node only for an ID and parameters returned by the current registry. Depend on the human gate where required.
4. Read the execution receipt and redacted output. Follow with a supported verification node or an agent connector check against the actual system.
5. Keep user reports, technical results and required acceptance separate.

## Agent connector work

Read the ready node and context, perform the authorized operation through the existing provider connector, then submit its nonsecret result with a stable request ID. Label it an agent report. Wait for required verification or human acceptance rather than inventing an executor receipt.

If a project task also coordinates this work, obtain its current claim and fence, preserve task checkpoints, and release or renew the lease as appropriate. The workflow node and task are separate identities.

## Missing registered action

Keep a draft nonexecutable. Record the exact missing capability and available alternatives. If human work is actually needed, give a bounded step with target, prerequisites, expected output and recovery; for a new project assignment, submit the complete proposal and obtain explicit owner acceptance in the portal. Continue unrelated ready work.
