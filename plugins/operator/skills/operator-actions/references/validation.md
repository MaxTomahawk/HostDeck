# Check action readiness

Before execution, inspect the current registered contract and resolve only the checks relevant to the requested action:

- Exact action ID, revision, target and required identity are available.
- Typed parameters and bounded operations match the intended effect; no freeform shell transport or undeclared input is introduced.
- Required inputs and prerequisites are satisfied; protected secrets remain on their permitted surface.
- Existing authorization covers the effect, and any actual human approval gate is satisfied.
- Timeout, output limits, redaction and the expected postcondition are understood.
- Current execution state permits the requested dispatch or recovery operation.
- A supported recovery or compensation is identified when the operation requires it.

Validation of a draft or a successful preview is not execution authority. If a required capability is missing, keep the draft nonexecutable and record the specific blocker. Do not manufacture a new action ID or promise compensation that the server does not support.
