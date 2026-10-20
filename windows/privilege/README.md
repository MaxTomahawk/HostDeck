# HostDeck Windows privilege broker

This directory contains a candidate Windows administrator broker. An enrolled client signs an arbitrary PowerShell script request; a protected Task Scheduler worker verifies the signature and runs the script as SYSTEM. It is intentionally general administration, not an action catalog. Anyone able to use an enrolled signing key can request SYSTEM code execution. Processes under the same Windows SID may be able to use that account's non-exportable key.

No task, identity, or privilege is installed by building this source. `implementation/Install-Broker.ps1` is preflight-only unless invoked with `-Apply` by an elevated administrator. Installation requires independently pinned SHA-256 values for the client enrollment, owner public DER certificate, native runner, and adjacent `implementation/source-sha256.json`. The installer validates that manifest, snapshots every implementation script, copies installed scripts from the snapshots, and verifies protected copies before registering its task.

Build the runner with `implementation/Build-Runner.ps1 -OutputDirectory <absolute-private-path>` using .NET 10. Keep all generated certificates, identities, enrollment files, receipts, and build output outside tracked source. Read `implementation/CODEX_INSTRUCTIONS.md` and the package provenance before deployment. Windows SYSTEM task, certificate ACL, cross-SID denial, reboot, and HostDeck/remote acceptance require separate live evidence.

`New-OwnerIdentity.ps1 -MachineStoreSoftwareKey` is an elevated, software-KSP-only owner-key option. It requires an Administrators/SYSTEM-only CNG key DACL and verifies it before exporting public DER. It does not establish a separate human account or an app-exclusive identity. The installed `public/clients.json` records client IDs, SIDs, public certificate thumbprints and store names so clients can discover their enrollment without private setup files.

The runner adapts HostDeck DesktopWorker JobRunner code. See `LICENSES/PROVENANCE.md`, `LICENSES/HostDeck_and_DesktopCommander_MIT.txt`, and `LICENSES/PACKAGE_MIT.txt`.
