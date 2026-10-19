# HostDeck engineering instructions

HostDeck is a Windows control product derived from the MIT-licensed Desktop Commander source. Preserve upstream copyright and license notices.

- Read `docs/MASTERPLAN.md` before product changes. While it remains in draft PR #2, read `git show origin/docs/hostdeck-masterplan-operator-13:docs/MASTERPLAN.md`. Do not confuse a written plan with implementation or acceptance.
- Git is the content authority. Reuse the existing HostDeck Operator project for readiness, dependencies, valid task leases/fences, evidence and review; Linear is the project overview. Do not create duplicate projects or fabricate task completion.
- Develop on temporary branches and submit PRs. Release only from reviewed, tested `main` commits. Preserve copied upstream branches until their unique work and licensing have been reviewed; never merge the Operator-only branches wholesale into the Windows product.
- Do not use GitHub Actions while the quota restriction applies. Build and test locally on Windows/WSL; report skipped or mock-only tests truthfully. Windows lifecycle and desktop acceptance require real Windows evidence.
- Follow `docs/PUBLIC_SOURCE_POLICY.md`. Never publish credentials, personal profile paths, private hostnames/topology, personal configuration or unsanitized logs/screenshots. Keep diagnostic evidence outside tracked files unless reviewed as public-safe.
- Before committing, stage exact files and run `python scripts/check-public-source.py --gitleaks <trusted-gitleaks-executable>`. Before release, also run it with `--scope history`; findings or scanner failures block publication pending review. These checks are bounded screening, not a complete privacy or security audit.
- Inspect install/runtime side effects before executing inherited code. Local dependency installation should use `npm ci --ignore-scripts`; review and run only required build/native steps. Upstream telemetry exists; do not silently send HostDeck data to upstream services.
- Local product work does not authorize changing production identities, DNS, tunnels, firewall rules or remote infrastructure. Use the controlling approval process and bounded registered Operator actions. Credentials and protected human input stay in their existing protected interface.
- Do not activate automatic upstream monitoring until final product acceptance and explicit owner permission.
- Preserve original scope: installer, service/session agent/tray, coherent MCP capabilities, durable jobs/artifacts, secure remote ingress, ChatGPT plugin, actual Windows install/upgrade/rollback, and independently checked acceptance. A passing unit test or source audit proves none of the other requirements.
