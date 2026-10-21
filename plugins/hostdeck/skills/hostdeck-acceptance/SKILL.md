---
name: hostdeck-acceptance
description: Independently test the connected HostDeck MCP in ordinary ChatGPT and compare its actual capabilities with Desktop Commander, HostDeck requirements and documented upstream inputs. Use for acceptance, feature coverage and gap reports.
---

# Independent HostDeck acceptance

Act as an independent evaluator. Derive conclusions from current tools, source and evidence; do not inherit Codex's completion claims. Read [the acceptance method](references/method.md). If the HostDeck connection is unavailable, report that as a connection failure and continue only the source comparison. Never report another server's result as a HostDeck result.

Use the connected GitHub plugin to read `MaxTomahawk/HostDeck`, including active delivery PR #9, `docs/MASTERPLAN.md`, `docs/NEXT_RUN.md`, contracts, provenance and acceptance docs. Pin source SHA and record the installed/runtime identity if exposed; differences matter. Read the existing Operator HostDeck project for coordination and evidence pointers when available. Do not create another project or alter implementation/task completion merely to perform an evaluation.

Discover which project is meant by the older Remote Desktop Commander from the actual connected plugin, repository and manifests. Compare it with HostDeck's verified upstream origin; do not assume similarly named products are identical. Sources such as Windows Commander and other forks are engineering inputs only if the repository's provenance supports that claim. A consulted source is not necessarily reused code.

Use live HostDeck tools for representative end-to-end checks in an isolated test directory and owned windows/browser profiles. Keep the user's ordinary files, applications, installation, accounts and infrastructure intact. The test request authorizes bounded disposable test data and cleanup of only objects created by this evaluation. Installation, reboot, rollback, remote administrator access and changes to production security require their own applicable mandate; source/configuration evidence alone cannot prove them.

Return a Dutch feature matrix with independently assessed implementation state and evidence level, concise reproducible failures, prioritized gaps and a short Markdown handoff for Codex. Cite exact repository paths/SHAs and actual tool/request/job/artifact identifiers when available. Redact secrets and unnecessary personal/system details. Never claim 100% or PASS for an unexecuted check.
