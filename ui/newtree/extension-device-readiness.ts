/**
 * Reuse HostDeck's existing authorized device_status tool. This is a bounded
 * device-level readback, not an extension install, capability or health probe.
 */
export type DeviceReadiness = 'ready' | 'unknown';

export async function readDeviceReadiness(
  call: (name: string) => Promise<unknown>,
  expectedDeviceId: string,
): Promise<DeviceReadiness> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(expectedDeviceId)) return 'unknown';
  try {
    const value = await call('hostdeck_device_status');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
    const record = value as Record<string, unknown>;
    return record.device_id === expectedDeviceId && record.status === 'ready' ? 'ready' : 'unknown';
  } catch {
    return 'unknown';
  }
}
