# HostDeck

HostDeck is a Windows device-management service with an authenticated MCP interface. It provides scoped access to an enrolled device's files and documents, bounded terminal jobs, desktop sessions, and a managed browser. Authorization, device identity, session eligibility, and effect approvals are enforced by the local service; connecting a client does not grant those permissions.

This repository is derived from the MIT-licensed Desktop Commander MCP project. Original MIT attribution and license terms are preserved in [LICENSE](LICENSE) and applicable source notices.

## Build and run locally

HostDeck currently targets Windows and requires Node.js 24.14.1 or later. From a reviewed checkout:

```powershell
npm ci --ignore-scripts
npm run build:hostdeck
node dist/hostdeck/main.js --stdio --config C:\ProgramData\HostDeck\hostdeck.json
```

Replace the sample config path with the absolute path to an owner-provisioned configuration. The build emits the HostDeck runtime at `dist/hostdeck/main.js` and the management UI assets. Starting the runtime requires that configuration, a matching desktop worker, state and grant files, and an eligible Windows user session. The service deliberately does not generate credentials, grants, device enrollment, remote ingress, or production identity configuration. Use the reviewed Windows setup instructions in `docs/` and keep secrets in their protected interfaces. The HTTP transport is enabled only through an explicit HTTP-mode command and valid server-side configuration.

The `hostdeck` npm executable points to the same built entry point after packaging or linking. For development, `npm run build:hostdeck` rebuilds the runtime and UI; HostDeck tool traffic uses MCP stdio unless the local HTTP configuration is explicitly enabled.

## Client package

`plugin/hostdeck/` contains the Agent Plugins 1.0 manifest, an authenticated OAuth MCP connection template, and the `hostdeck-operations` Skill with references. The template's `${HOSTDECK_MCP_URL}` is preparation only: a reachable, verified HTTPS endpoint and working OAuth registration are still required. The current gateway defaults to loopback, so a ChatGPT-hosted client cannot reach it without separately approved and configured ingress.

`ui/newtree/` contains the MCP Apps management panel and the local `/ui` interface. The panel uses actual MCP responses for device status, sessions, windows, jobs, files, bounded terminal jobs, and screenshot artifacts. See [docs/CLIENT.md](docs/CLIENT.md) for platform setup requirements and acceptance boundaries.

## Current status

This source package is under development. A build or focused test does not establish a complete Windows installation or product acceptance. Service lifecycle, installer and rollback, remote OAuth/ingress, real ChatGPT tool discovery and interaction, and independent end-to-end acceptance remain outstanding. Automatic upstream monitoring is inactive.

Read [docs/NEXT_RUN.md](docs/NEXT_RUN.md) for the current execution checkpoint and [docs/PUBLIC_SOURCE_POLICY.md](docs/PUBLIC_SOURCE_POLICY.md) before preparing public changes.
