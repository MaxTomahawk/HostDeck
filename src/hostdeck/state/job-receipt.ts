/** Interpret only a runner's owned completion receipt. An accepted cancel request is
 * not a terminal outcome; native descendant containment must be explicit.
 * This module never launches, kills, retries or replays a job.
 */
// This provenance is fixed by the owning StateServices job reservation/launch
// metadata, never inferred from potentially truncated or corrupt receipt fields.
export type RunnerProtocol = 'native-job-object-v1' | 'legacy-powershell-v1';

export type FinalJobStatus = 'succeeded' | 'failed' | 'timed_out' |
  'cancelled' | 'interrupted' | 'uncertain';

export interface ReceiptVerdict {
  status: FinalJobStatus;
  exitCode?: number | null;
  descendantsContained?: boolean;
  message?: string;
}

const NATIVE_STATUSES = new Set(['completed', 'failed', 'timed_out',
  'cancelled', 'interrupted', 'uncertain']);
const uncertain = (message: string): ReceiptVerdict => ({
  status: 'uncertain', descendantsContained: false, message,
});
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const exitCode = (value: unknown): number | null | undefined =>
  value === null ? null : typeof value === 'number' && Number.isInteger(value) &&
    value >= 0 && value <= 0xffffffff ? value : undefined;

export function interpretJobReceipt(input: unknown, expectedProtocol: RunnerProtocol | undefined): ReceiptVerdict {
  // Old jobs without a recorded protocol cannot be classified from a receipt:
  // a damaged native receipt may have the same shape as legacy PowerShell.
  if (expectedProtocol !== 'native-job-object-v1' && expectedProtocol !== 'legacy-powershell-v1') {
    return uncertain('Persisted runner protocol is unavailable; command outcome remains uncertain.');
  }
  const value = record(input);
  if (!value) return uncertain('Runner completion receipt is invalid; process outcome remains uncertain.');
  const status = value.status;
  const code = exitCode(value.exitCode);
  if (expectedProtocol === 'native-job-object-v1') {
    // No fallthrough to legacy just because native status/containment is absent.
    if (typeof status !== 'string') {
      return uncertain('Native runner receipt is missing its status; descendant containment and outcome remain uncertain.');
    }
    if (!NATIVE_STATUSES.has(status) ||
        !Object.prototype.hasOwnProperty.call(value,'exitCode') ||
        code === undefined || typeof value.descendantsContained !== 'boolean') {
      return uncertain('Native runner completion receipt is invalid; process outcome remains uncertain.');
    }
    const contained = value.descendantsContained;
    if (status === 'uncertain') {
      return uncertain('Runner could not prove that the owned descendant tree ended; outcome remains uncertain.');
    }
    // A failed pre-effect validation has no child process and no exit code.
    // Do not falsely represent it as a successful command effect.
    if (status === 'failed' && code === null && !contained) {
      return { status: 'failed', exitCode: null, descendantsContained: false,
        message: 'Runner rejected execution; no confirmed command completion is recorded.' };
    }
    // Any terminal EFFECT receipt needs positive process-tree containment.
    // A native cancellation request alone is not a confirmed cancellation.
    if (!contained) {
      return uncertain('Runner reported a terminal state without confirmed descendant containment; outcome remains uncertain.');
    }
    if (status === 'completed') {
      if (code === null || code === undefined) {
        return uncertain('Runner reported completion without a valid exit code; outcome remains uncertain.');
      }
      return { status: code === 0 ? 'succeeded' : 'failed',
        exitCode: code, descendantsContained: true };
    }
    if (status === 'failed') {
      if (code === undefined) {
        return uncertain('Runner reported failure without a valid exit code; outcome remains uncertain.');
      }
      return { status: 'failed', exitCode: code, descendantsContained: true };
    }
    if (status === 'timed_out' || status === 'cancelled' || status === 'interrupted') {
      return { status, exitCode: code ?? null, descendantsContained: true };
    }
    return uncertain('Runner completion status is unknown.');
  }
  // Only job metadata explicitly marked legacy permits the old receipt shape.
  // A native status field on a legacy job is a protocol mismatch, not success.
  // Legacy exit status never asserts descendant containment.
  if (status === undefined && code !== undefined && code !== null &&
      (value.timedOut === undefined || typeof value.timedOut === 'boolean')) {
    return { status: value.timedOut === true ? 'timed_out' : code === 0 ? 'succeeded' : 'failed',
      exitCode: code, message: 'Legacy runner has no verified descendant-containment receipt.' };
  }
  return uncertain('Runner completion receipt has no supported outcome; process result remains uncertain.');
}
