/**
 * HostDeck B007 manager presentation model.
 * A catalogue candidate is never treated as installed/qualified on the basis of
 * its research record. The only live overlay comes from authenticated
 * hostdeck_list_providers, and only the existing preference API may mutate it.
 */
import { EXTENSION_CANDIDATES, type ExtensionCandidate } from './extension-catalog-data.js';

export type Observation = 'yes' | 'no' | 'unknown' | 'on_demand';
export interface LiveProvider {
  id: string;
  capabilities?: unknown;
  installed?: unknown; enabled?: unknown; running?: unknown;
  compatible?: unknown; healthy?: unknown; qualified?: unknown;
  reason?: unknown; version?: unknown; instance?: unknown; session_id?: unknown;
}
export interface LiveFunction {
  capability: string; preference: string | null; default: string; selected: string;
}
export interface ProviderSnapshot {
  providers: LiveProvider[];
  functions: LiveFunction[];
}
export interface ManagerEntry {
  candidate: ExtensionCandidate;
  providerId: string | null;
  live: LiveProvider | null;
  actualCapabilities: readonly string[];
  states: {
    installed: Observation; enabled: Observation; running: Observation;
    onDemand: Observation; compatible: Observation; healthy: Observation;
    selected: Observation; qualified: 'verified' | 'not_accepted' | 'unknown';
  };
  reason: string;
  activeFunctions: readonly string[];
}
export interface ManagerFilters {
  search?: string; category?: string; presence?: string; qualification?: string;
  selected?: string; capability?: string; sort?: string;
  enabled?: string; running?: string; healthy?: string; compatible?: string; onDemand?: string;
}
const builtinDirect: ExtensionCandidate = Object.freeze({
  id: 'HOSTDECK-INTERNAL-DIRECT', name: 'HostDeck direct filesystem',
  category: 'File name/metadata', origin: 'HostDeck source provider',
  upstreamVersionObservation: '', licenseResearchHint: 'Product MIT/upstream notices',
  researchDisposition: 'BUILT_IN_PROVIDER', researchQualification: 'NOT_INDEPENDENTLY_TESTED_HERE',
  ownerPriority: false, capabilityHints: ['files.name', 'files.content'],
});

function text(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 240) : '';
}
function observed(value: unknown): Observation {
  return value === true ? 'yes' : value === false ? 'no' : 'unknown';
}
function qualified(value: unknown): ManagerEntry['states']['qualified'] {
  // Only a server-expressed independent acceptance state counts as verified.
  if (value === 'independently_accepted') return 'verified';
  if (value === false || value === 'not_independently_accepted') return 'not_accepted';
  return 'unknown';
}
function providerId(candidate: ExtensionCandidate): string | null {
  if (candidate.id === builtinDirect.id) return 'direct';
  if (candidate.id === 'EXT-CAND-0001') return 'everything';
  return null;
}
function actualFunctionIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string =>
    typeof item === 'string' && /^[a-z][\w.-]{1,75}$/.test(item)) : [];
}
export function assertProviderSnapshot(value: unknown): ProviderSnapshot {
  if (!value || typeof value !== 'object') throw new Error('PROVIDER_SNAPSHOT_INVALID');
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.providers) || !Array.isArray(input.functions) ||
      input.providers.length > 100 || input.functions.length > 200) {
    throw new Error('PROVIDER_SNAPSHOT_INVALID');
  }
  const providers: LiveProvider[] = [];
  const seenProviders = new Set<string>();
  for (const item of input.providers) {
    if (!item || typeof item !== 'object') throw new Error('PROVIDER_SNAPSHOT_INVALID');
    const record = item as LiveProvider;
    if (typeof record.id !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(record.id) ||
        seenProviders.has(record.id)) throw new Error('PROVIDER_SNAPSHOT_INVALID');
    seenProviders.add(record.id);
    providers.push(record);
  }
  const functions: LiveFunction[] = [];
  const seenFunctions = new Set<string>();
  for (const item of input.functions) {
    if (!item || typeof item !== 'object') throw new Error('PROVIDER_SNAPSHOT_INVALID');
    const record = item as LiveFunction;
    if (typeof record.capability !== 'string' || !/^[a-z][a-z0-9._-]{1,75}$/.test(record.capability) ||
        seenFunctions.has(record.capability) || typeof record.selected !== 'string' ||
        typeof record.default !== 'string' ||
        !(record.preference === null || typeof record.preference === 'string')) {
      throw new Error('PROVIDER_SNAPSHOT_INVALID');
    }
    seenFunctions.add(record.capability);
    functions.push(record);
  }
  return { providers, functions };
}
export function mergeManagerCatalog(snapshot: ProviderSnapshot): ManagerEntry[] {
  const byId = new Map(snapshot.providers.map(item => [item.id, item]));
  const all = [builtinDirect, ...EXTENSION_CANDIDATES];
  // Future provider registrations can appear without falsely adding them to
  // the reviewed research corpus or silently dropping a live provider.
  const recognised = new Set(['direct', 'everything']);
  const unknownLive = snapshot.providers.filter(item => !recognised.has(item.id)).map(item => ({
    id: 'HOSTDECK-LIVE-' + item.id, name: 'Provider: ' + item.id,
    category: 'Other live provider', origin: 'HostDeck runtime (not in 79-candidate research)',
    upstreamVersionObservation: '', licenseResearchHint: 'Not reviewed',
    researchDisposition: 'UNLISTED_LIVE_PROVIDER', researchQualification: 'UNKNOWN',
    ownerPriority: false, capabilityHints: [] as string[],
  } satisfies ExtensionCandidate));
  return [...all, ...unknownLive].map(candidate => {
    const id = providerId(candidate) ??
      (candidate.id.startsWith('HOSTDECK-LIVE-') ? candidate.id.slice('HOSTDECK-LIVE-'.length) : null);
    const live = id ? byId.get(id) ?? null : null;
    const running = live?.running === 'on_demand' ? 'on_demand' : observed(live?.running);
    const activeFunctions = id
      ? snapshot.functions.filter(item => item.selected === id).map(item => item.capability) : [];
    return {
      candidate, providerId: id, live, actualCapabilities: actualFunctionIds(live?.capabilities),
      states: {
        installed: live ? observed(live.installed) : 'unknown',
        enabled: live ? observed(live.enabled) : 'unknown',
        running,
        onDemand: running === 'on_demand' ? 'yes' : live?.running === true ? 'no' : 'unknown',
        compatible: live ? observed(live.compatible) : 'unknown',
        healthy: live ? observed(live.healthy) : 'unknown',
        selected: live ? (activeFunctions.length ? 'yes' : 'no') : 'unknown',
        qualified: live ? qualified(live.qualified) : 'unknown',
      },
      reason: live ? text(live.reason) : 'No supported HostDeck runtime probe for this research candidate.',
      activeFunctions,
    };
  });
}
export function managerCategories(entries: readonly ManagerEntry[]): string[] {
  return [...new Set(entries.map(entry => entry.candidate.category))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
}
export function filterManagerEntries(entries: readonly ManagerEntry[], options: ManagerFilters): ManagerEntry[] {
  const query = (options.search ?? '').trim().normalize('NFKC').toLocaleLowerCase();
  const filtered = entries.filter(entry => {
    const { candidate, live, states } = entry;
    if (query && ![candidate.name, candidate.id, candidate.category, candidate.origin,
      candidate.licenseResearchHint, candidate.upstreamVersionObservation,
      ...candidate.capabilityHints, ...entry.actualCapabilities]
      .join(' ').normalize('NFKC').toLocaleLowerCase().includes(query)) return false;
    if (options.category && options.category !== 'all' && candidate.category !== options.category) return false;
    if (options.presence && options.presence !== 'all') {
      if (options.presence === 'live' && !live) return false;
      if (options.presence !== 'live' && states.installed !== options.presence) return false;
    }
    if (options.qualification && options.qualification !== 'all' &&
        states.qualified !== options.qualification) return false;
    if (options.selected && options.selected !== 'all' &&
        states.selected !== options.selected) return false;
    for (const [key, state] of [
      ['enabled', states.enabled], ['running', states.running],
      ['healthy', states.healthy], ['compatible', states.compatible],
      ['onDemand', states.onDemand],
    ] as const) {
      if (options[key] && options[key] !== 'all' && options[key] !== state) return false;
    }
    if (options.capability && options.capability !== 'all' &&
        !entry.actualCapabilities.includes(options.capability) &&
        !candidate.capabilityHints.includes(options.capability)) return false;
    return true;
  });
  const sort = options.sort ?? 'name';
  const comparator = (a: ManagerEntry, b: ManagerEntry): number => {
    const first = sort === 'category' ? a.candidate.category
      : sort === 'installed' ? a.states.installed
      : sort === 'qualification' ? a.states.qualified
      : a.candidate.name;
    const second = sort === 'category' ? b.candidate.category
      : sort === 'installed' ? b.states.installed
      : sort === 'qualification' ? b.states.qualified
      : b.candidate.name;
    return first.localeCompare(second, undefined, { numeric: true, sensitivity: 'base' }) ||
      a.candidate.name.localeCompare(b.candidate.name, undefined, { numeric: true, sensitivity: 'base' }) ||
      a.candidate.id.localeCompare(b.candidate.id);
  };
  return filtered.sort(comparator);
}
export function groupManagerEntries(entries: readonly ManagerEntry[], groupBy: string): Array<{ name: string; entries: ManagerEntry[] }> {
  if (groupBy === 'none') return [{ name: 'All matching entries', entries: [...entries] }];
  const groups = new Map<string, ManagerEntry[]>();
  for (const entry of entries) {
    const names = groupBy === 'capability'
      ? (entry.actualCapabilities.length ? entry.actualCapabilities
        : entry.candidate.capabilityHints.length
          ? entry.candidate.capabilityHints.map(value => value + ' · research hint')
          : ['Not mapped'])
      : [groupBy === 'installed' ? entry.states.installed
        : groupBy === 'qualification' ? entry.states.qualified
        : entry.candidate.category];
    for (const name of names) {
      const group = groups.get(name) ?? []; group.push(entry); groups.set(name, group);
    }
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, items]) => ({ name, entries: items }));
}
export function supportedPreferenceOptions(capability: string): Array<{ id: string | null; label: string }> {
  // Exact B007 source contract; unknown future functions remain read-only.
  if (capability !== 'files.name' && capability !== 'files.content') return [];
  return [
    { id: null, label: 'Automatic · stable direct default' },
    { id: 'direct', label: 'HostDeck direct filesystem' },
    ...(capability === 'files.name' ? [{ id: 'everything', label: 'Everything (if available)' }] : []),
  ];
}
export function preferenceChanged(before: LiveFunction, after: LiveFunction, desired: string | null): boolean {
  return before.capability !== after.capability ||
    after.preference !== desired;
}
