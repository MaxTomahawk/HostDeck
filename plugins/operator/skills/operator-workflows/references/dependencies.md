# Dependencies and evidence

Keep original human outcomes, project task states, workflow node states and execution receipts distinct. A source-linked human gate is decided from the canonical plan step. Caller completion claims, project checkpoints or connector reports cannot override it.

Prerequisites block dependent work until the server considers them satisfied. Original human `depends_on` relationships remain enforced at their completion and execution boundary. Preserve dependency identities when linking steps into projects or workflows.

The worker evaluates eligible bounded actions and durable state transitions. It does not admit model-written commands to the registry or provide an autonomous LLM execution host. Task assignment and lease ownership coordinate work; they do not grant privileges.

Keep failure and unknown side effects visible. Pause prevents new workflow dispatch; cancellation cannot undo an already dispatched action. Use only supported compensation and recovery. For project tasks, explicit rework invalidates dependent claims/results for rechecking; reread the graph before continuing downstream.
