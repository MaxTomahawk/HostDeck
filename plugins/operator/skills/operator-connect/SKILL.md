---
name: operator-connect
description: Check a previously authenticated Operator MCP connection, discover live capabilities and troubleshoot missing tools without replacing OAuth.
---
# Connect

1. Discover the existing connected Operator MCP App; do not register a duplicate.
2. Use a read-only capability, profile or plan-list tool to verify connectivity, avoiding dummy production records.
3. Confirm the actual authenticated user and organization when a profile tool exists.
4. Inspect currently available tool schemas; missing project tools may mean an older server release.
5. Preserve existing OAuth and app permissions. Do not request tokens, session cookies or secrets in chat.
6. Report unavailability accurately. Installing a skills package does not deploy the server or create an app.
