/** Public-safe error codes only; never carry raw filesystem/process exceptions. */
export class RuntimeError extends Error {
  constructor(readonly code: string) { super(code); }
}
