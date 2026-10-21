# Acceptance method

## Establish scope and authority

1. Verify this is ordinary ChatGPT and inventory the actual connected HostDeck tools and host-supported resources/prompts/Apps. Record which protocol surfaces the host does not expose; do not assume every MCP method is a callable model tool. Record local time with Europe/Amsterdam offset, plugin/package version, runtime version/device identity where available, and the exact reviewed source SHA.
2. Read `MaxTomahawk/HostDeck` delivery PR #9 and its current branch, then `docs/MASTERPLAN.md`, `docs/NEXT_RUN.md`, `docs/MCP_CONTRACT.md`, `docs/ENGINE_QUALIFICATION.md`, `SOURCE_MANIFEST.json`, `windows/vendor/PROVENANCE.md`, `docs/WINDOWS.md`, `docs/SECURITY_MODEL.md`, `docs/SECURITY_ACCEPTANCE.md`, `docs/UPSTREAM.md` and the relevant implementation/tests. Discover actual paths rather than assuming all listed files still exist. `main`, a development branch, a packaged candidate and the installed runtime can differ. Date-stamped docs may describe an earlier foundation; compare their claims with code and live results.
3. If an existing connected Operator project for HostDeck is available to the user, consult it only for coordination/evidence pointers. Follow actual artifact references; a checkpoint is a report, not independent execution evidence. Private local receipts unavailable to ChatGPT remain **unverified**, not **missing implementation**. Do not request secrets or indiscriminate diagnostic dumps.

## Build the comparison

Determine the actual origin of the user's older Remote Desktop Commander plugin. Inspect its exposed tools and verified repository; separately identify HostDeck's Desktop Commander origin from Git/remotes/manifests. Treat `wonderwhy-er/DesktopCommanderMCP` as a candidate to verify, not an identity asserted by this document.

Inspect `docs/ENGINE_QUALIFICATION.md`, `SOURCE_MANIFEST.json`, Git diffs and vendor provenance for actual use and decisions around `exalsch/windows-commander-mcp`, `CursorTouch/Windows-MCP`, `deploymenttheory/windows-mcp-server`, `TransductiveScience/desktop-commander-mcp` and any other recorded sources. Follow real repository URLs and pinned revisions. Distinguish **copied/modified**, **dependency**, **behavior reference**, **evaluated/rejected**, **planned** and **unknown**. Preserve licensing context. Compare relevant pinned revisions and current upstream behavior separately; do not attribute new upstream functions to an older installed HostDeck build.

Derive a complete checklist from the masterplan and implementation rather than this illustrative list alone:

- File discovery/search/read/edit/move and structured documents/PDFs.
- Terminal and interactive processes versus durable jobs, cancellation/timeout, idempotency, reconnect, output artifacts and integrity.
- Windows discovery/focus/UIA, screenshot/OCR, pointer/keyboard, clipboard formats and eligible-session boundaries.
- Managed browser navigation/DOM interaction, profile ownership, egress and cleanup.
- Devices, diagnostics, scoped identity/grants, events/audit and negative authorization.
- MCP tools/resources/prompts, structured errors/results and actual ChatGPT tool selection.
- Management App/UI rendering and a real interaction, not only resource discovery or HTML source.
- Installer, LocalService, user agent/tray, automatic startup, actual reboot, upgrade/rollback and recovery.
- Direct Windows Cloudflare/OAuth ingress and independent management recovery.
- Permanent signed local administrative broker, audit/receipts, replay/uncertain-result recovery and explicit local/remote authorization boundaries. Local acceptance does not grant remote administrator access.
- Developer/release docs, licenses, update provenance and public-source/history release gates.

## Execute bounded representative tests

Start with authenticated device/status and harmless reads. For each exposed supported subsystem, use a fresh disposable fixture under a server-authorized test directory. Test meaningful input→effect→returned result, read back created data, verify artifact bytes/hashes where exposed, and inspect terminal receipts before marking jobs successful. Reuse actual IDs on follow-up reads; never replay uncertain effects.

For GUI/browser tests use only an explicitly identified test window/profile and read its result before another action. Do not capture unrelated private content. Test authorization boundaries through harmless denied/read-only cases or isolated fixtures; do not probe another person's device or mutate a real protected path to demonstrate a denial.

Compare the old plugin and HostDeck with equivalent safe fixtures when both connections are available. If the old plugin is absent, label its comparison **source/documentation only** and continue. A missing reference connector is not a reason to stop testing HostDeck.

Do not reboot the user's PC, stop existing services, install software, update/rollback the running product, change DNS/firewall/accounts, or open a privileged shell merely to complete this test report. Review available receipts and mark their evidence level. Preserve all user data. Clean up only exact fixtures owned by this run after recording their results; never perform broad recursive cleanup from an inferred path.

## Report format

Give a short verdict followed by a table:

`Feature | Old plugin/baseline | HostDeck intended | HostDeck implementation | Live result/evidence level | Evidence ref | Gap/action`

Implementation states: **implemented**, **partial**, **absent**, **unknown**. Test results: **PASS**, **FAIL**, **NOT TESTED**, **BLOCKED**, **NOT APPLICABLE**. Evidence levels: **live in this chat**, **independently inspected receipt**, **source only**, **documented claim only**, **unavailable**. Do not collapse these into one status. An advertised schema or a passing mock is not live implementation proof. A runtime failure can be configuration, access, compatibility or implementation; identify what the evidence establishes.

If giving completion percentages, show the checklist, denominator, weights and how unknown/blocked items count. Otherwise omit percentages. End with top gaps ordered by user impact and a compact `CODEX_HANDOFF.md` block containing source/runtime versions, reproduced steps, redacted error, expected/actual behavior and the next concrete repair. Keep it usable in a fresh Codex chat without this conversation's history.
