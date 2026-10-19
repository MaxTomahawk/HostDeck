# Public source and branch policy

HostDeck is a public product repository. Original MIT attribution remains in LICENSE. Never copy private configuration, credentials, local profile paths, hostnames, infrastructure addresses, unsanitized runtime output or personal screenshots into tracked source, commit messages, PR bodies or release archives.

## Local publication checks

Use Python 3, Git, and a trusted Gitleaks v8 executable. Obtain Gitleaks from its official release and verify the archive against the published checksum before execution. The baseline audit used v8.30.1. No hosted CI is required.

```powershell
python test/test-public-source-guard.py
python scripts/check-public-source.py --gitleaks gitleaks
python scripts/check-public-source.py --scope history --gitleaks gitleaks
```

For the tests, set `HOSTDECK_TEST_GITLEAKS` to an installed scanner's absolute executable path when it is not on PATH. This is a tool path, never a credential.

The default check inspects staged filenames and the staged diff's added lines, including added content even if the working file differs. It blocks common private filenames and runs Gitleaks with default detection rules, ignored inline allow-comments and an empty ignore file. Repository allowlists cannot silently weaken these checks. It invokes tools with argument arrays and emits only a finding summary, without matching text or scanner diagnostics.

Exit 0 means this bounded scan passed, 1 means publication findings, and 2 means inspection/scanner failure. A missing scanner is a failure. The script does not install tools, change Git settings, delete history or send data to a remote service.

The history scope scans all reachable refs. It includes removed secrets in historical diffs. This is required before release and is expected to fail on the current inherited baseline: credential candidates remain in upstream history. Do not suppress that failure with a broad allowlist or call it a clean release audit. Escalate the specific risk for review and remediation under the appropriate authority; do not test exposed credentials against a live service.

Staged checks exclude untracked/unstaged files and existing commits. Neither scope proves absence of personal data or secrets in all binary/archive objects, screenshots, externally hosted artifacts, unreachable history or releases. Review the exact changes and packaged artifacts separately. Example files also require content review even when their filenames are allowed. Generated reports stay in private storage until sanitized.

## Branch and license rules

- Releases originate only from reviewed and locally tested main commits. Develop on branches with pull requests; do not trigger GitHub Actions while the quota restriction applies.
- Preserve upstream and copied fork branches until their unique commits and open PRs have been assessed. An ancestor or identical tree does not itself authorize deletion.
- The Operator-only marketplace branches are references for the separate Operator plugin. Their tree removes the desktop implementation and LICENSE. Never merge those trees wholesale into HostDeck.
- Preserve root MIT notices when rebranding or packaging. Reassess attribution and redistribution rights for every imported engine/module and shipped dependency. The baseline register is not a final SBOM or legal clearance of future integrations.

## Attribution register at the initial baseline

| Source | Revision | Disposition |
|---|---|---|
| wonderwhy-er/DesktopCommanderMCP | f508e524469c26f6366e17dbfd3ee5a69d112127 | MIT source inherited in main; original root license retained; telemetry and install hooks require review before execution |
| HostDeck masterplan, PR #2 | 1d7c43e89984d1675591d99e1268cdb5f4273f3c | Product intent; no runtime or acceptance claim |
| Fork-only Operator plugin branches | Tree acc85ff20991fdf7adba15f1271eba5b10824e3e | Preserve as references; no desktop source imported from these trees |
| Earlier HostDeck 0.1.0-dev.1 archive | Source bytes not yet available | No module reused or licensed by assumption; source recovery and qualification remain open |

The source reconciliation audit records exact branches and redacted scanner evidence privately through Operator. It found 27 historical telemetry credential candidates of unknown validity, five dummy test findings and two documentation placeholders. All three current worktree findings were dummy redaction fixtures. Values are deliberately omitted. Historical credentials remain a release risk; author identities and required notices remain original Git attribution.
