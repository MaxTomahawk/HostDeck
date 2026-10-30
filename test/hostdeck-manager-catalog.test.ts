import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXTENSION_CANDIDATES } from '../ui/newtree/extension-catalog-data.js';
import {
  assertProviderSnapshot, filterManagerEntries, groupManagerEntries, managerCategories,
  mergeManagerCatalog, preferenceChanged, supportedPreferenceOptions,
} from '../ui/newtree/extension-catalog.js';

function snapshot() {
  return assertProviderSnapshot({
    providers: [
      { id: 'direct', installed: true, enabled: true, running: 'on_demand',
        compatible: true, healthy: true, capabilities: ['files.name', 'files.content'] },
      { id: 'everything', installed: true, enabled: true, running: true,
        compatible: true, healthy: false, reason: 'loading <img src=x onerror=bad()>',
        qualified: 'not_independently_accepted', version: '1.5.x',
        capabilities: ['files.name'] },
    ],
    functions: [
      { capability: 'files.name', preference: 'everything', default: 'direct', selected: 'everything' },
      { capability: 'files.content', preference: null, default: 'direct', selected: 'direct' },
    ],
  });
}

test('all 79 research candidates retained without approval, install or machine assumptions', () => {
  assert.equal(EXTENSION_CANDIDATES.length, 79);
  assert.equal(new Set(EXTENSION_CANDIDATES.map(item => item.id)).size, 79);
  assert.ok(EXTENSION_CANDIDATES.every(item => /^EXT-CAND-\d{4}$/.test(item.id)));
  assert.ok(EXTENSION_CANDIDATES.every(item => item.researchDisposition === 'RESEARCH_ONLY'));
  assert.deepEqual(EXTENSION_CANDIDATES.filter(item => item.ownerPriority).map(item => item.name), ['Everything']);
  const entries = mergeManagerCatalog({ providers: [], functions: [] });
  assert.equal(entries.length, 80, '79 candidates plus one internal direct provider');
  assert.equal(managerCategories(entries).length, 13);
  assert.ok(entries.every(item => item.states.installed === 'unknown' &&
    item.states.qualified === 'unknown'));
  assert.equal(entries.find(item => item.candidate.id === 'EXT-CAND-0001')?.live, null);
});

test('actual provider observations are overlaid separately without assuming accepted qualification', () => {
  const data = mergeManagerCatalog(snapshot());
  const direct = data.find(item => item.providerId === 'direct')!;
  const everything = data.find(item => item.providerId === 'everything')!;
  assert.equal(data.length, 80);
  assert.deepEqual([direct.states.installed, direct.states.enabled, direct.states.running,
    direct.states.onDemand, direct.states.compatible, direct.states.healthy, direct.states.qualified],
    ['yes', 'yes', 'on_demand', 'yes', 'yes', 'yes', 'unknown']);
  assert.equal(direct.states.selected, 'yes', 'files.content is selected');
  assert.deepEqual([everything.states.installed, everything.states.healthy,
    everything.states.selected, everything.states.qualified],
    ['yes', 'no', 'yes', 'not_accepted']);
  assert.equal(everything.activeFunctions.join(','), 'files.name');
  assert.equal(everything.candidate.researchDisposition, 'RESEARCH_ONLY');
  assert.match(everything.reason, /loading/);
  assert.ok(!everything.reason.includes('<script>'));
  const other = data.find(item => item.candidate.id === 'EXT-CAND-0010')!;
  assert.equal(other.states.installed, 'unknown', 'source version cannot establish presence');
});

test('catalogue filters work across independent axes without local Windows discovery', () => {
  const data = mergeManagerCatalog(snapshot());
  assert.equal(filterManagerEntries(data, { search: 'eVeRyThInG' }).length, 1);
  assert.equal(filterManagerEntries(data, { search: 'EXT-CAND-0010' }).length, 1);
  assert.equal(filterManagerEntries(data, { category: 'Text/content' }).length, 8);
  assert.equal(filterManagerEntries(data, { presence: 'live' }).length, 2);
  assert.equal(filterManagerEntries(data, { presence: 'yes', healthy: 'no' }).length, 1);
  assert.equal(filterManagerEntries(data, { selected: 'yes' }).length, 2);
  assert.equal(filterManagerEntries(data, { qualification: 'not_accepted' }).length, 1);
  assert.equal(filterManagerEntries(data, { capability: 'files.content', presence: 'live' }).length, 1);
  assert.equal(filterManagerEntries(data, { onDemand: 'yes' }).length, 1);
  assert.equal(filterManagerEntries(data, { enabled: 'no', presence: 'live' }).length, 0);
  assert.equal(filterManagerEntries(data, { compatible: 'yes', healthy: 'unknown' }).length, 0);
  assert.ok(filterManagerEntries(data, { sort: 'name' }).length === 80);
});

test('function grouping distinguishes real capabilities and research-only hints', () => {
  const data = mergeManagerCatalog(snapshot());
  const groups = groupManagerEntries(data, 'capability');
  assert.ok(groups.some(group => group.name === 'files.name'));
  assert.ok(groups.some(group => group.name === 'files.content'));
  assert.ok(groups.some(group => group.name === 'files.name · research hint'));
  assert.ok(groups.some(group => group.name === 'Not mapped'));
  const unique = new Set(groups.flatMap(group => group.entries.map(item => item.candidate.id)));
  assert.equal(unique.size, 80, 'grouped repeated entries do not create additional candidates');
});

test('only B007 provider preference choices are offered; saved preferences do not auto-fallback', () => {
  assert.deepEqual(supportedPreferenceOptions('files.content').map(item => item.id), [null, 'direct']);
  assert.deepEqual(supportedPreferenceOptions('files.name').map(item => item.id), [null, 'direct', 'everything']);
  const before = snapshot().functions[0];
  assert.equal(before.preference, 'everything');
  assert.equal(before.selected, 'everything', 'unhealthy selected provider remains visible without silent rewrite');
  assert.equal(preferenceChanged(before, { ...before, preference: 'direct' }, 'everything'), true);
  assert.equal(preferenceChanged(before, before, 'everything'), false);
});

test('malformed, duplicate or unexpected provider snapshots fail closed', () => {
  assert.throws(() => assertProviderSnapshot({ providers: null, functions: [] }), /PROVIDER_SNAPSHOT_INVALID/);
  assert.throws(() => assertProviderSnapshot({ providers: [{ id: 'direct' }, { id: 'direct' }],
    functions: [] }), /PROVIDER_SNAPSHOT_INVALID/);
  assert.throws(() => assertProviderSnapshot({ providers: [], functions: [
    { capability: 'files.name', preference: null, selected: 'direct', default: 'direct' },
    { capability: 'files.name', preference: null, selected: 'direct', default: 'direct' },
  ] }), /PROVIDER_SNAPSHOT_INVALID/);
  const unknown = assertProviderSnapshot({ providers: [{ id: 'future_provider', installed: false }],
    functions: [] });
  const entries = mergeManagerCatalog(unknown);
  assert.equal(entries.length, 81);
  const future = entries.find(item => item.providerId === 'future_provider')!;
  assert.equal(future.candidate.researchDisposition, 'UNLISTED_LIVE_PROVIDER');
  assert.equal(future.states.installed, 'no');
  assert.equal(future.states.qualified, 'unknown');
});
