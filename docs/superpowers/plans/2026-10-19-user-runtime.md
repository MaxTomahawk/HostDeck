# HostDeck user runtime implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Owner authorization already requests autonomous implementation and independent review.

**Goal:** Execute real local file/document/process work through the canonical contracts without starting the inherited server or telemetry.

**Architecture:** Internal user-runtime adapter, no listener. A trusted facade authorization callback must admit each request and recheck effects. A fixed device and explicit workspace/environment bind each instance. Only actual supported handlers are listed; unsupported variants fail before effects. This does not authenticate remote clients or establish Windows identity.

**Tech Stack:** Existing TypeScript/Zod, Node filesystem/child-process, existing MIT DOCX/Excel handlers, installed pdf-lib/unpdf packages. No new package or native install hook.

**Spec:** `docs/MASTERPLAN.md` (draft PR #2 fallback), `docs/SECURITY_MODEL.md`, `docs/MCP_CONTRACT.md`.

## Global constraints

- No GitHub Actions or upstream runtime startup/telemetry.
- Never execute commands as a service; future OS-authenticated user bootstrap is mandatory before deployment.
- Node path checks alone are not a hostile-process filesystem sandbox. File-only remote authority stays disabled until native handle/token enforcement exists.
- Shell authority is broad user authority; explicit environment and working directory are execution hygiene, not shell confinement.
- No automatic replay, silent target substitution or unimplemented capability advertisement.
- Original archive/provenance gate stays open. Existing inherited handlers keep their MIT attribution.

## Review focus

- A denied or revoked request must not create a file or process.
- Device mismatch, unknown operation and forged raw process ID must fail before dispatch.
- Repeated text and document edits must fail on count mismatch without rewriting content.
- Output must preserve UTF-8 chunk boundaries and explicitly report retention limits; no unbounded memory growth.
- Process errors/exits and unsupported cancellation must be truthful, with no inferred descendant termination.

### Task 1: Internal files and documents

**Files:** Create `src/hostdeck/user-runtime.ts`, `test/hostdeck-user-runtime.test.ts`; modify `package.json`.

**Interfaces:** `UserRuntime.create({deviceId, workspace, authorize, environment, shells})`; `invoke(name, arguments)` parses canonical schemas, checks admission and returns typed data. `implementedTools` lists actual handlers only. `dispose()` stops owned direct children.

- [ ] Add real temporary-directory tests for denied writes, explicit device, strict schema, UTF-8 line reads/tails, expected-count edits and non-text rejection.
- [ ] Run with `node --import tsx --test test/hostdeck-user-runtime.test.ts`; observe missing behavior, then implement using bounded file buffers and a serialized file queue.
- [ ] Add real DOCX/XLSX fixtures using existing handlers and PDF fixtures using pdf-lib. Verify reads/edits, mismatch safety, path/link checks and unsupported renderer refusal.
- [ ] Implement only reviewed document dependencies; generic errors never include raw caller data. No existing startup/config imports.
- [ ] Run the tests, full build and applicable inherited tests in an isolated telemetry-disabled test environment.

### Task 2: Owned interactive processes

**Files:** Same adapter/tests; split process manager if the adapter ceases to be readable.

**Interfaces:** `start_process`, `read_process`, `interact_process` use opaque per-instance IDs. Explicit executable paths are trusted server configuration; request selects only a configured shell. Initial observation timeout never claims command completion.

- [ ] Add actual Windows shell tests for stdout/stderr, input, exit, observation timeout, bounded output, unknown/foreign handles, denied spawn and minimal environment.
- [ ] Observe failing tests; implement pipes and bounded UTF-8 output using Node child process handles.
- [ ] Do not advertise process-tree cancellation until native descendant tracking exists. Disposal closes only direct owned children and reports that limit.
- [ ] Re-run files/contracts/process tests and full build; request independent review, fix findings with regressions and perform staged public-source checks.
- [ ] Integrate reviewed code via PR; record exact evidence and remaining native/document/transport gaps in Operator. Keep the runtime task open if any acceptance criterion remains unmet.
