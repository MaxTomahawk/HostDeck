/**
 * Host-provided MCP Apps notifications are presentation hints only.
 * A valid device/view context can select UI state, never grant permission.
 * Every subsequent tool invocation remains authorized by HostDeckFacade.
 */
export interface ManagerHostContext { device_id: string; view: 'providers'; }
export interface ManagerToolInput { device_id: string; }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

export function parseManagerHostInput(params: unknown): ManagerToolInput | null {
  if (!isRecord(params) || !isRecord(params.arguments) ||
      !hasExactKeys(params.arguments, ['device_id']) ||
      !isDeviceId(params.arguments.device_id)) return null;
  return {device_id: params.arguments.device_id};
}

export function parseManagerHostResult(value: unknown, expectedInput: ManagerToolInput | null): ManagerHostContext | null {
  // Never infer a device from host messages without a validated matching input
  // AND a server-produced result. Ignore the untrusted plain text content.
  if (!expectedInput || !isRecord(value) || value.isError === true ||
      !isRecord(value.structuredContent) ||
      !hasExactKeys(value.structuredContent, ['result'])) return null;
  const result = value.structuredContent.result;
  if (!isRecord(result) || !hasExactKeys(result, ['device_id', 'view']) ||
      !isDeviceId(result.device_id) || result.device_id !== expectedInput.device_id ||
      result.view !== 'providers') return null;
  return {device_id: result.device_id, view: 'providers'};
}

/** Applies validated presentation context, never performs a tool call. */
export function applyManagerHostContext(
  context: ManagerHostContext | null,
  ready: boolean,
  update: (deviceId: string, view: 'providers') => void,
): boolean {
  if (!ready || !context || !isDeviceId(context.device_id) ||
      context.view !== 'providers') return false;
  update(context.device_id, context.view);
  return true;
}
