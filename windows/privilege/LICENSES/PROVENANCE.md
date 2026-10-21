# Provenance and licence

`runner/Program.cs` was adapted from `MaxTomahawk/HostDeck/windows/HostDeck.DesktopWorker/JobRunner.cs` at Git object `8d017fe7fb4f6cc638b8dd30a00ee9bff0d96893`, in branch `codex/delivery`, commit `2c4929dd4b118e41eedd714c973c35398271adaf` (2026-10-20), which contains MIT-copyrighted original Desktop Commander-derived code. The original license notice is in `LICENSES/HostDeck_and_DesktopCommander_MIT.txt`.

Changes: SYSTEM/Session-0 requirement; protected separate work root; new request schema; isolated executable/script path; 900-second cap and 16-MiB stdout/stderr cap; output receipts; no GUI/desktop features; explicitly minimal Win32 environment; 64-bit self-contained executable. This is **not** a binary of the upstream project. Compiled outputs are not tracked with this source; local build receipts belong outside the repository.

The implementation scripts and local documentation are provided under the accompanying MIT notice (`LICENSES/PACKAGE_MIT.txt`). This source tree contains no private HostDeck configuration, credentials, or compiled binaries.
