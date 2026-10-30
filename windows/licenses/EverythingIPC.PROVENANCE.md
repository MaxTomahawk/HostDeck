# Everything local IPC protocol

HostDeck's native `EverythingIpc.cs` implements the documented voidtools IPC2 request/reply layout and constants. The integration does not redistribute or load the vendor SDK DLLs or install/update Everything. HostDeck source retains its original MIT notices.

Reference: https://www.voidtools.com/support/everything/sdk/ipc/

Inspected SDK archive: https://www.voidtools.com/Everything-SDK.zip, SHA-256 `f5716d9513cce6b462b5170a0a2e7e081e191d9bcac6774f5decc061497df443`, inspected 26 October 2026. The reference SDK source identifies Copyright (C) 2022 David Carpenter under MIT; its notice is retained in `EverythingIPC.LICENSE.txt`. The archive and example binaries are engineering references, not shipped runtime inputs.

The current real local test tuple is Everything 1.5.0.1423b, Windows x64 and an eligible unelevated user session. IPC2 documentation also covers the 1.4 family; that is not runtime qualification of an untested version. ES was considered but no usable client was found in the inspected installation/PATH locations. Direct IPC avoids a new vendor executable dependency while retaining explicit process/version/session checks. Performance and independent client/lifecycle acceptance remain separate evidence.
