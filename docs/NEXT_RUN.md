# HostDeck next execution run

## Outcome

Complete the HostDeck product described in `MASTERPLAN.md`; a timebox or task status is not acceptance. Work from temporary branches and reviewed PRs. GitHub is the source-review path; use the existing Operator project for readiness, dependencies, valid leases/fences, evidence and review. Stop Linear planning/sync. Do not use GitHub Actions while quota restrictions apply.

## Five implementation packages

1. Runtime foundation: MCP facade, adapters, policy, OAuth and stable contracts.
2. Windows lifecycle: service, per-session GUI worker, browser/tray, installer, update and rollback.
3. Durable execution: jobs, artifacts, devices, routing, events and recovery.
4. Client experience: ChatGPT plugin/Skills/resources/Apps and justified local UI.
5. Integration and acceptance: secure remote ingress, actual Windows install, real ChatGPT discovery/use, upgrade/rollback, release hygiene, documentation and manual upstream reconciliation.

Parallelize packages only against stable contracts. Only the integration package accepts cross-package results. Root owns shared package files and commits; avoid worktrees unless conflicts require isolation. Preserve copied upstream branches until their unique work and licensing are reviewed; reuse old archive material only after provenance, license, compatibility and security checks. Automatic upstream monitoring stays backlog until acceptance and explicit owner permission.

## Run shape (five hours, target only)

- 0–15 min: freeze interfaces, inspect current state and assign bounded packages.
- 15–165 min: up to three workers plus root on independent packages.
- 165–240 min: root integrates and resolves contract breaks.
- 240–300 min: real acceptance, focused fixes and evidence capture.

Timebox is not a completion guarantee. Do not claim unverified work as done. Use at most three concurrent workers plus root: `gpt-6-luna` medium for bounded ordinary work; `gpt-6-sol` medium only for complex security/native work. Root handles integration and one focused final risk review. Give workers short self-contained assignments and disjoint files, without full chat history. Reuse workers; do not spawn new implementer/reviewer pairs for each small change.

Resume from this file and the five live Operator packages, not the full old chat or every historical plan. Read earlier evidence only for the module being changed; keep tool output compact. Use installed dependencies and prior passing evidence unless a changed dependency or failure justifies reinstall/retesting. Prefer adapting the already qualified source over writing another replacement engine.

## Verification and release boundaries

Use one meaningful targeted check per changed subsystem, batch build/integration once, and rerun only changed or failing paths. Existing 14+11 passing checks remain prior evidence. The inherited 164/174 result with ten failures is triage context; investigate relevance and do not erase real failures. Report skipped, mocked and unavailable checks accurately.

Completion still requires actual Windows install and service/session behavior, authenticated client and real ChatGPT tool discovery/use, durable job/restart behavior, secure remote authorization and deny cases, upgrade/rollback, and independent acceptance evidence. Keep credentials, protected input, personal paths, private topology and unsanitized diagnostics out of tracked/public artifacts. Inspect inherited-code side effects; use `npm ci --ignore-scripts` and run only reviewed required build/native steps. No production identity, DNS, tunnel, firewall or remote infrastructure changes without the controlling approval process and bounded registered Operator action.

Before commits, stage exact files and run the public-source scanner with trusted Gitleaks; before release also scan history. Scanner findings or failures block publication pending review. Release only from reviewed, tested `main`; preserve required upstream notices. No task or plan status substitutes for code and acceptance evidence.
