# Secrets and execution boundaries

- Enter secrets only through the existing protected portal or provider control. Do not assume browser-local protected values synchronize to other devices or constitute an external vault.
- MCP may declare secret fields, never carry their values. Reject secret-bearing plan values, tool arguments, task metadata, comments, checkpoints, uploads and screenshots.
- A registry contract owns the exact operation, target, identity, required inputs and output checks. A plan command, project task, claim or workflow node cannot create execution authority.
- Keep human intent approval separate from technical authorization. Clicking Run confirms the specific permitted operation; it cannot override an unavailable action, failed prerequisite or protected channel restriction.
- Use only the current registered execution route. Do not create arbitrary shell transport, bypass the execution service, switch identities or broaden account permissions to make a call succeed.
- Process output and expected markers support the specific technical claim they establish. Agent verification and explicit human acceptance remain separate when required.
- Secret retention, escrow or external vault writes require an actual supported integration and authorization. Do not promise them from a field declaration or upload reference.
