# Reusable human interaction types

Use these as authoring patterns, not as assumed registered templates.

| Pattern | When needed | Evidence |
| --- | --- | --- |
| `account-login` | Sign-in or consent requires the actual account owner | User reports the expected account view |
| `mfa-approval` | Passkey or physical device approval | Confirmation of the approved session, never the code |
| `secret-input` | A registered action needs protected input | Secret is entered in the canonical portal field |
| `device-check` | Physical or visual behavior must be checked | Relevant device, expected behavior and nonsecret feedback |
| `file-handoff` | Authorized transfer or upload needs human action | Actual receipt, hash/metadata or clearly labeled user report |
| `human-decision` | A material choice requires the person | Explicit choice, reason when needed and recorded time |
| `manual-command` | No authorized automated route is available | Exact target, bounded command, expected output and reported result |
| `review-output` | Human experience or judgment matters | User feedback, kept separate from technical evidence |

Complete work that available tools can already perform under the user's authorization. Before proposing new project work to a person, record the alternative using agents/tools, current limitations, expected quality and benefit through the project proposal API. Proposal creation is not acceptance; only the owner can accept in the portal.

Compose ordinary plan steps and supported fields while preserving existing identities and outcomes. Keep secrets and credentials off chat, comments, evidence screenshots and task checkpoints. Human work may precede a bounded action and subsequent agent verification; dependent branches wait while independent ready work continues.
