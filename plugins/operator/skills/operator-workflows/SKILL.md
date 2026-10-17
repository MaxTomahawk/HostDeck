---
name: operator-workflows
description: Compose and resume durable dependency workflows with human approval gates and bounded action receipts.
---
# Workflows

1. Inspect supported workflow nodes, the existing plan and available registered actions.
2. Define prerequisites and durable node IDs with stable request IDs.
3. Start only authorized effects; human/MFA/secret gates stay on their protected surfaces.
4. Distinguish workflow state, agent reports, and server-verified executor receipts.
5. Keep unknown, failed or blocked nodes visible; reconcile before retrying.
6. Do not claim continuous autonomous execution without a configured scheduler.
7. Respect authentication errors and the server's existing privilege boundaries.
