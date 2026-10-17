---
name: operator-actions
description: Inspect approved bounded actions, preserve authorization and idempotency, and verify executable outcomes.
---
# Actions

1. Inspect the available registered actions and accepted parameters.
2. Never invent privileged action IDs, sudo rights or arbitrary shell tool calls.
3. Preview exact typed inputs, plan IDs and versions when the MCP supports them.
4. Human approval, MFA and secret entry stay in the existing private portal or provider.
5. Execute only authorized bounded actions with stable request IDs; inspect receipts and postconditions.
6. An unknown outcome is not safe to retry blindly. Reconcile with the original request ID.
7. Recovery requires a registered, separately authorized compensation action.
