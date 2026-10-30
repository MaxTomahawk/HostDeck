/**
 * Extension manager view for HostDeck's existing MCP App / same-origin UI.
 * No new authorization, backend endpoint, lifecycle effect or background poller.
 */
import {
  assertProviderSnapshot, mergeManagerCatalog, managerCategories,
  filterManagerEntries, groupManagerEntries, supportedPreferenceOptions,
  type ManagerEntry, type ProviderSnapshot, type LiveFunction,
} from './extension-catalog.js';
import {readDeviceReadiness} from './extension-device-readiness.js';

export interface ManagerConnection {
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  deviceId: () => string;
  isCurrent: () => boolean;
}

function add(parent: HTMLElement, tag: string, content?: string, className?: string): HTMLElement {
  const item = document.createElement(tag);
  if (content !== undefined) item.textContent = content;
  if (className) item.className = className;
  parent.append(item);
  return item;
}
function button(parent: HTMLElement, label: string, handler: () => void): HTMLButtonElement {
  const item = add(parent, 'button', label) as HTMLButtonElement;
  item.type = 'button'; item.addEventListener('click', handler); return item;
}
function field(parent: HTMLElement, label: string, id: string, options: readonly (readonly [string, string])[]): HTMLSelectElement {
  const container = add(parent, 'label', label);
  const input = document.createElement('select'); input.id = id;
  for (const [value, title] of options) {
    const option = document.createElement('option'); option.value = value; option.textContent = title; input.append(option);
  }
  container.append(input);
  return input;
}
function stateLabel(value: string): string {
  return value === 'yes' ? 'Yes' : value === 'no' ? 'No'
    : value === 'on_demand' ? 'On demand'
    : value === 'verified' ? 'Independently accepted'
    : value === 'not_accepted' ? 'Not independently accepted'
    : 'Unknown';
}
function fieldValue(root: HTMLElement, label: string, value: string): void {
  add(root, 'dt', label); add(root, 'dd', value);
}

export function mountExtensionManager(host: HTMLElement, connection: ManagerConnection): void {
  host.classList.add('manager');
  const current = () => connection.isCurrent() && host.isConnected;
  const endpoint = (name: string, args?: Record<string, unknown>) => connection.call(name, args);
  add(host, 'h2', 'Extension library');
  add(host, 'p',
    '79 researched candidates and one HostDeck built-in provider. Research does not prove software is installed, enabled, qualified or supported.');
  const actions = add(host, 'div', undefined, 'manager-actions');
  const refreshButton = button(actions, 'Refresh live providers', () => { void refresh(); });
  const liveStatus = add(host, 'p', 'Live provider status not loaded.', 'manager-notice');
  liveStatus.id = 'provider-status';
  liveStatus.setAttribute('role', 'status');
  liveStatus.setAttribute('aria-live', 'polite');
  const deviceReadiness = add(host, 'p', 'HostDeck device readiness: not verified. Provider readiness is separate.', 'manager-note');
  deviceReadiness.setAttribute('role', 'status');
  add(host, 'p', 'The Everything integration can be enabled or disabled for this owner and device. Vendor software install, start, stop, configure, update, repair and rollback are unavailable here.', 'manager-note');

  const nav = add(host, 'div', undefined, 'manager-tabs');
  nav.setAttribute('role', 'group'); nav.setAttribute('aria-label', 'Manager sections');
  const tabLibrary = button(nav, 'Library', () => switchTab('library'));
  const tabFunctions = button(nav, 'Functions and preferences', () => switchTab('functions'));
  const tabChanges = button(nav, 'Changes', () => switchTab('changes'));

  const library = add(host, 'section', undefined, 'manager-section');
  library.setAttribute('aria-label', 'Extension library');
  const functions = add(host, 'section', undefined, 'manager-section');
  functions.setAttribute('aria-label', 'Provider functions and preferences');
  const changes = add(host, 'section', undefined, 'manager-section');
  changes.setAttribute('aria-label', 'Change evidence in this page session');
  const filters = add(library, 'div', undefined, 'manager-filters');
  const searchLabel = add(filters, 'label', 'Search candidate, ID, category or source');
  const search = document.createElement('input');
  search.id = 'extension-search'; search.autocomplete = 'off';
  search.placeholder = 'Search all 79 candidates'; searchLabel.append(search);
  const category = field(filters, 'Category', 'extension-category', [['all', 'All categories']]);
  const presence = field(filters, 'Installed', 'extension-presence', [
    ['all', 'All'], ['live', 'Provider API returned'], ['yes', 'Installed'],
    ['no', 'Not installed'], ['unknown', 'Unknown'],
  ]);
  const qualification = field(filters, 'Qualification', 'extension-qualification', [
    ['all', 'All'], ['verified', 'Independently accepted'],
    ['not_accepted', 'Not independently accepted'], ['unknown', 'Unknown'],
  ]);
  const selected = field(filters, 'Selected', 'extension-selected', [
    ['all', 'All'], ['yes', 'Selected'], ['no', 'Not selected'], ['unknown', 'Unknown'],
  ]);
  const advanced = add(filters, 'details', undefined, 'manager-advanced');
  add(advanced, 'summary', 'More status filters');
  const advancedFields = add(advanced, 'div', undefined, 'manager-advanced-fields');
  const enabled = field(advancedFields, 'Enabled', 'extension-enabled', [
    ['all', 'All'], ['yes', 'Enabled'], ['no', 'Disabled'], ['unknown', 'Unknown'],
  ]);
  const running = field(advancedFields, 'Running', 'extension-running', [
    ['all', 'All'], ['yes', 'Running'], ['no', 'Not running'],
    ['on_demand', 'On demand'], ['unknown', 'Unknown'],
  ]);
  const onDemand = field(advancedFields, 'On demand', 'extension-on-demand', [
    ['all', 'All'], ['yes', 'Yes'], ['no', 'No'], ['unknown', 'Unknown'],
  ]);
  const compatible = field(advancedFields, 'Compatible', 'extension-compatible', [
    ['all', 'All'], ['yes', 'Compatible'], ['no', 'Incompatible'], ['unknown', 'Unknown'],
  ]);
  const healthy = field(advancedFields, 'Healthy', 'extension-healthy', [
    ['all', 'All'], ['yes', 'Healthy'], ['no', 'Unhealthy'], ['unknown', 'Unknown'],
  ]);
  const capability = field(filters, 'Function', 'extension-capability', [
    ['all', 'All functions'], ['files.name', 'File names and paths'],
    ['files.content', 'File content'],
  ]);
  const sort = field(filters, 'Sort by', 'extension-sort', [
    ['name', 'Name'], ['category', 'Category'], ['installed', 'Installation state'],
    ['qualification', 'Qualification'],
  ]);
  const grouping = field(filters, 'Group by', 'extension-group', [
    ['category', 'Category'], ['capability', 'Function / candidate hint'],
    ['installed', 'Installed state'],
    ['qualification', 'Qualification'], ['none', 'None'],
  ]);
  const clearFilters = button(filters, 'Clear filters', () => {
    search.value = ''; category.value = 'all'; presence.value = 'all';
    qualification.value = 'all'; selected.value = 'all'; capability.value = 'all';
    enabled.value = 'all'; running.value = 'all'; onDemand.value = 'all';
    compatible.value = 'all'; healthy.value = 'all';
    sort.value = 'name'; grouping.value = 'category'; limit = 30; renderList(); search.focus();
  });
  clearFilters.classList.add('manager-secondary');
  const counts = add(library, 'p', '', 'manager-count'); counts.id = 'extension-count'; counts.setAttribute('role', 'status');
  const layout = add(library, 'div', undefined, 'manager-layout');
  const results = add(layout, 'div', undefined, 'manager-results'); results.id = 'extension-results';
  const detail = add(layout, 'section', undefined, 'manager-detail');
  detail.id = 'extension-detail'; detail.setAttribute('aria-label', 'Extension details');
  const more = button(library, 'Show more', () => { limit += 30; renderList(); });
  more.id = 'extension-more';

  let entries: ManagerEntry[] = mergeManagerCatalog({ providers: [], functions: [] });
  let snapshot: ProviderSnapshot | null = null;
  let tab: 'library' | 'functions' | 'changes' = 'library';
  let selectedId: string | null = null;
  let limit = 30, busy = false, saving = false;
  let lastChange: { capability: string; preference: string | null; outcome: string; readback: string } | null = null;
  let requestedSerial = 0;
  let snapshotDevice = '';
  let enableFeedback = 'No integration change attempted.';

  function switchTab(target: 'library' | 'functions' | 'changes'): void {
    tab = target;
    library.hidden = target !== 'library'; functions.hidden = target !== 'functions'; changes.hidden = target !== 'changes';
    tabLibrary.setAttribute('aria-pressed', String(target === 'library'));
    tabFunctions.setAttribute('aria-pressed', String(target === 'functions'));
    tabChanges.setAttribute('aria-pressed', String(target === 'changes'));
    if (target === 'functions') renderFunctions();
    if (target === 'changes') renderChanges();
  }
  function showDetails(entry: ManagerEntry, focus: boolean): void {
    detail.replaceChildren();
    const heading = add(detail, 'h3', entry.candidate.name); heading.tabIndex = -1;
    add(detail, 'p', entry.candidate.id + ' · ' + entry.candidate.category, 'manager-muted');
    const dl = add(detail, 'dl', undefined, 'manager-dl');
    fieldValue(dl, 'Research source', entry.candidate.origin + ' · ' + entry.candidate.researchDisposition);
    fieldValue(dl, 'Research qualification', entry.candidate.researchQualification + ' (not a local runtime acceptance)');
    fieldValue(dl, 'Owner delivery priority', entry.candidate.ownerPriority
      ? 'Selected as a delivery priority (not a general install or qualification approval)'
      : 'No candidate-specific adoption approved by this catalogue');
    fieldValue(dl, 'Upstream version observed (not local)', entry.candidate.upstreamVersionObservation || 'Unknown');
    fieldValue(dl, 'Actual local version', typeof entry.live?.version === 'string' ? entry.live.version : 'Unknown');
    fieldValue(dl, 'License (research hint, not adoption)', entry.candidate.licenseResearchHint);
    fieldValue(dl, 'Live capabilities', entry.actualCapabilities.join(', ') || 'None reported');
    fieldValue(dl, 'Candidate domain (not confirmed)', entry.candidate.capabilityHints.join(', ') || 'Not mapped');
    fieldValue(dl, 'Selected for', entry.activeFunctions.join(', ') || (entry.live ? 'No function' : 'No live provider'));
    const axes = [
      ['Installed', entry.states.installed], ['Integration enabled', entry.states.enabled],
      ['Running', entry.states.running], ['On demand', entry.states.onDemand],
      ['Compatible', entry.states.compatible], ['Healthy', entry.states.healthy],
      ['Selected', entry.states.selected], ['Qualification', entry.states.qualified],
    ];
    for (const [label, value] of axes) fieldValue(dl, label, stateLabel(value));
    fieldValue(dl, 'Integration configured', entry.live?.configured === true ? 'Yes' : entry.live?.configured === false ? 'No' : 'Unknown');
    fieldValue(dl, 'Probe reason / limit', entry.reason || 'No reason returned');
    fieldValue(dl, 'Instance', typeof entry.live?.instance === 'string' ? entry.live.instance : 'Unknown');
    fieldValue(dl, 'Session', typeof entry.live?.session_id === 'number' ? String(entry.live.session_id) : 'Unknown');
    add(detail, 'h4', 'Lifecycle actions');
    add(detail, 'p', 'Vendor software install, start, stop, configure, update, repair and rollback are unavailable. Catalogue entries do not authorize effects.');
    if(entry.providerId==='everything')renderEnablement(entry);
    if(entry.providerId==='direct')add(detail,'p','Built-in direct integration is always enabled and cannot be disabled.');
    if (entry.live && entry.providerId) button(detail, 'Manage supported preference', () => {
      switchTab('functions');
      functions.querySelector<HTMLSelectElement>('#provider-function')?.focus();
    });
    if (focus) heading.focus();
  }
  function renderEnablement(entry:ManagerEntry):void {
    add(detail,'h4','HostDeck integration');
    add(detail,'p','This owner/device/executor setting controls Everything searches. It preserves saved preferences and does not install, start, stop or qualify Everything. Disabled selections fail without fallback.');
    const live=entry.live;
    if(typeof live?.desiredEnabled!=='boolean'||!(live.enabledOverride===null||typeof live.enabledOverride==='boolean')) {
      add(detail,'p','Logical integration state unavailable; refresh before editing.');return;
    }
    const prior=live.enabledOverride;
    const choice=field(detail,'Desired integration enablement','provider-enabled',[
      ['','Automatic · enabled by default'],['true','Enabled'],['false','Disabled'],
    ]);
    choice.value=prior===null?'':String(prior);
    const apply=button(detail,'Apply integration setting',()=>{void save();});
    apply.id='provider-enabled-apply';
    const feedback=add(detail,'p',enableFeedback);feedback.id='provider-enabled-feedback';
    feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');
    const selected=():boolean|null=>choice.value===''?null:choice.value==='true';
    const update=()=>{apply.disabled=busy||saving||selected()===prior;choice.disabled=saving;};
    choice.addEventListener('change',update);update();
    async function save():Promise<void> {
      if(busy||saving||!current())return;
      const desired=selected(),target=connection.deviceId(),serial=requestedSerial;
      if(desired===prior)return;
      if(!snapshotDevice||target!==snapshotDevice) {
        enableFeedback=feedback.textContent='Device changed since inspection. Refresh live providers first; no write sent.';return;
      }
      saving=true;refreshButton.disabled=true;update();
      const valid=()=>current()&&connection.deviceId()===target&&requestedSerial===serial;
      const message=(value:string)=>{enableFeedback=value;if(current())feedback.textContent=value;};
      lastChange={capability:'Everything integration',preference:desired===null?'Automatic (enabled)':desired?'Enabled':'Disabled',outcome:'Preflight',
        readback:'Not yet verified. Current state is checked before and after saving. A concurrent change may still cause a mismatch; refresh to reconcile.'};
      try {
        message('Checking latest integration setting before any change…');
        const before=assertProviderSnapshot(await endpoint('hostdeck_list_providers'));
        if(!valid())throw new Error('Device or context changed; no write attempted.');
        const fresh=before.providers.find(item=>item.id==='everything');
        if(!fresh||fresh.enabledOverride!==prior||fresh.desiredEnabled!==live!.desiredEnabled) {
          snapshot=before;entries=mergeManagerCatalog(before);lastChange.outcome='Conflict before write';
          message('Integration setting changed externally: no write issued. Inspect current state.');return;
        }
        message('Applying scoped integration setting…');
        const receipt=await endpoint('hostdeck_set_provider_enabled',{provider:'everything',enabled:desired});
        if(!valid())throw new Error('Device or context changed after write; outcome uncertain. Refresh to reconcile.');
        if(receipt?.updated!==true||receipt.provider!=='everything'||receipt.enabledOverride!==desired||receipt.desiredEnabled!==(desired??true))
          throw new Error('Write confirmation missing; outcome uncertain. Refresh before retrying.');
        const after=assertProviderSnapshot(await endpoint('hostdeck_list_providers'));
        if(!valid())throw new Error('Device or context changed before readback; outcome uncertain.');
        snapshot=after;entries=mergeManagerCatalog(after);
        const checked=after.providers.find(item=>item.id==='everything');
        if(checked?.enabledOverride!==desired||checked.desiredEnabled!==(desired??true)) {
          lastChange.outcome='Conflict / readback mismatch';message('Server receipt and current integration setting disagree; do not automatically retry.');
        } else {
          lastChange.outcome='Readback confirmed';lastChange.readback='The saved setting matches the current device readback. Vendor running and health states are separate.';
          message('Integration setting verified on readback. Vendor running and health states remain separate.');
        }
      } catch(error) {
        lastChange.outcome='Uncertain / failed';
        message((error instanceof Error?error.message.slice(0,180):'Request failed.')+' Refresh to reconcile; do not blindly retry.');
      } finally {
        saving=false;refreshButton.disabled=false;
        if(current()){renderList();if(tab==='functions')renderFunctions();}
      }
    }
  }
  function renderList(): void {
    if (!current()) return;
    const matching = filterManagerEntries(entries, {
      search: search.value, category: category.value, presence: presence.value,
      qualification: qualification.value, selected: selected.value,
      capability: capability.value, sort: sort.value,
      enabled: enabled.value, running: running.value, onDemand: onDemand.value,
      compatible: compatible.value, healthy: healthy.value,
    });
    counts.textContent = String(matching.length) + ' matching of ' + String(entries.length) +
      ' entries; ' + String(Math.min(limit, matching.length)) + ' on this page. ' +
      String(entries.filter(item => item.candidate.id.startsWith('EXT-CAND-')).length) + ' research candidates retained.';
    results.replaceChildren();
    const visible = matching.slice(0, limit);
    for (const group of groupManagerEntries(visible, grouping.value)) {
      const section = add(results, 'section', undefined, 'manager-group');
      add(section, 'h3', group.name + ' (' + String(group.entries.length) + ' on this page)');
      for (const entry of group.entries) {
        const card = add(section, 'article', undefined, 'manager-entry');
        add(card, 'h4', entry.candidate.name);
        add(card, 'p', entry.candidate.id + ' · ' + entry.candidate.category +
          (entry.candidate.ownerPriority ? ' · Owner delivery priority' : ''), 'manager-muted');
        add(card, 'p', 'Installed: ' + stateLabel(entry.states.installed) +
          ' · Healthy: ' + stateLabel(entry.states.healthy) +
          ' · Qualification: ' + stateLabel(entry.states.qualified));
        const inspect = button(card, 'Details', () => { selectedId = entry.candidate.id; showDetails(entry, true); });
        inspect.setAttribute('aria-label', 'Details for ' + entry.candidate.name);
      }
    }
    if (!visible.length) add(results, 'p', 'No matching candidates. This local catalogue filter does not scan Windows.');
    more.hidden = matching.length <= limit;
    const same = matching.find(item => item.candidate.id === selectedId);
    if (same) showDetails(same, false);
    else { selectedId = null; detail.replaceChildren();
      add(detail, 'p', 'Select Details for provenance, qualifications and separate observed status axes.'); }
  }
  for (const select of [search, category, presence, qualification, selected, capability,
    enabled, running, onDemand, compatible, healthy, sort, grouping]) {
    select.addEventListener(select === search ? 'input' : 'change', () => { limit = 30; renderList(); });
  }
  function renderChanges(): void {
    changes.replaceChildren();
    add(changes, 'h3', 'Current page session');
    if (lastChange) {
      add(changes, 'p', lastChange.capability + ' → ' + (lastChange.preference ?? 'Automatic') + ' · ' + lastChange.outcome);
      add(changes, 'p', lastChange.readback);
    } else add(changes, 'p', 'No provider setting change attempted during this page session.');
    add(changes, 'p', 'No durable lifecycle receipt/change-log API exists here. Closing this panel clears the local display; it neither replays nor reverts saved preferences.');
  }
  function renderFunctions(): void {
    functions.replaceChildren();
    add(functions, 'h3', 'Function preferences');
    add(functions, 'p', 'Preference is scoped by the authenticated owner, device and function. It does not install, start or qualify a provider; automatic default remains direct.');
    if (!snapshot) { add(functions, 'p', 'Live provider function state unavailable; refresh before editing.'); return; }
    if (!snapshot.functions.length) { add(functions, 'p', 'No functions were returned by HostDeck.'); return; }
    const fnSelect = field(functions, 'Function', 'provider-function', snapshot.functions.map(fn => [
      fn.capability, fn.capability === 'files.name' ? 'File names and paths' :
        fn.capability === 'files.content' ? 'File content' : fn.capability,
    ] as const));
    const preference = field(functions, 'Saved preference', 'provider-preference', []);
    const effective = add(functions, 'p', '', 'manager-notice');
    const feedback = add(functions, 'p', '', 'manager-notice');
    feedback.id = 'preference-feedback'; feedback.setAttribute('role', 'status');
    const apply = button(functions, 'Save preference', () => { void savePreference(); });
    apply.id = 'provider-apply';
    function selectedFunction(): LiveFunction | undefined {
      return snapshot?.functions.find(fn => fn.capability === fnSelect.value);
    }
    function renderPreference(): void {
      const fn = selectedFunction();
      preference.replaceChildren();
      if (!fn) { apply.disabled = true; effective.textContent = 'Function unavailable.'; return; }
      const available = supportedPreferenceOptions(fn.capability);
      for (const choice of available) {
        const option = document.createElement('option'); option.value = choice.id ?? '';
        option.textContent = choice.label; preference.append(option);
      }
      if (!available.some(choice => choice.id === fn.preference)) {
        const other = document.createElement('option'); other.value = fn.preference ?? '';
        other.textContent = 'Saved but unsupported: ' + String(fn.preference);
        other.disabled = true; preference.append(other);
      }
      preference.value = fn.preference ?? '';
      const actual = entries.find(row => row.providerId === fn.selected);
      effective.textContent = 'Saved: ' + (fn.preference ?? 'Automatic') + ' · Default: ' + fn.default +
        ' · Selected now: ' + fn.selected +
        (actual && actual.states.healthy !== 'yes' ? ' · Current health not confirmed.' : '') +
        ' Explicit preference is never silently replaced by another provider.';
      apply.disabled = saving || preference.value === (fn.preference ?? '');
    }
    async function savePreference(): Promise<void> {
      const fn = selectedFunction();
      if (!fn || saving || !current()) return;
      const desired = preference.value || null;
      if (!supportedPreferenceOptions(fn.capability).some(choice => choice.id === desired)) {
        feedback.textContent = 'Unsupported choice; no change made.'; return;
      }
      if (desired === fn.preference) { feedback.textContent = 'Preference unchanged.'; return; }
      saving = true; apply.disabled = true; preference.disabled = true; fnSelect.disabled = true;
      refreshButton.disabled = true;
      const target = connection.deviceId();
      if (!snapshotDevice || target !== snapshotDevice) {
        saving = false; apply.disabled = false; preference.disabled = false; fnSelect.disabled = false;
        refreshButton.disabled = false;
        feedback.textContent = 'Device changed since provider inspection. Refresh live providers first; no write sent.';
        return;
      }
      lastChange = { capability: fn.capability, preference: desired, outcome: 'Preflight',
        readback: 'Not yet verified. Backend does not offer atomic revision preconditions or a durable manager receipt.' };
      feedback.textContent = 'Checking latest saved preference before any change…';
      try {
        const before = assertProviderSnapshot(await endpoint('hostdeck_list_providers'));
        if (!current() || connection.deviceId() !== target) throw new Error('Device changed; no write attempted.');
        const fresh = before.functions.find(item => item.capability === fn.capability);
        if (!fresh || fresh.preference !== fn.preference) {
          snapshot = before; entries = mergeManagerCatalog(before);
          lastChange.outcome = 'Conflict before write';
          feedback.textContent = 'Preference changed externally: no write issued. Inspect current state.';
          return;
        }
        feedback.textContent = 'Applying scoped preference…';
        const receipt = await endpoint('hostdeck_set_provider_preference', {
          capability: fn.capability, provider: desired,
        });
        if (!receipt || receipt.updated !== true || receipt.capability !== fn.capability ||
            receipt.preference !== desired) {
          throw new Error('Write confirmation missing; outcome uncertain. Refresh before retrying.');
        }
        const after = assertProviderSnapshot(await endpoint('hostdeck_list_providers'));
        if (!current() || connection.deviceId() !== target) throw new Error('Device changed before readback; reconcile before retrying.');
        snapshot = after; entries = mergeManagerCatalog(after);
        const checked = after.functions.find(item => item.capability === fn.capability);
        if (!checked || checked.preference !== desired) {
          lastChange.outcome = 'Conflict / readback mismatch';
          feedback.textContent = 'Server receipt and current saved preference disagree; do not automatically retry.';
        } else {
          lastChange.outcome = 'Readback confirmed';
          lastChange.readback = 'set_provider_preference returned updated=true, then list_providers showed the requested saved preference in this device context. No lifecycle effect or qualification claimed.';
          feedback.textContent = 'Preference verified on readback. Selected provider: ' + checked.selected + '.';
        }
      } catch (error) {
        if (lastChange) lastChange.outcome = 'Uncertain / failed';
        feedback.textContent = (error instanceof Error ? error.message.slice(0, 180) : 'Request failed.') +
          ' Refresh to reconcile; do not blindly retry.';
      } finally {
        saving = false;
        refreshButton.disabled = false; fnSelect.disabled = false; preference.disabled = false;
        if (current()) { renderPreference(); renderList(); }
      }
    }
    fnSelect.addEventListener('change', renderPreference);
    preference.addEventListener('change', () => { apply.disabled = saving || preference.value === (selectedFunction()?.preference ?? ''); });
    renderPreference();
  }
  async function refresh(): Promise<void> {
    if (busy || saving || !current()) return;
    busy = true; refreshButton.disabled = true;
    liveStatus.setAttribute('aria-busy', 'true');
    liveStatus.textContent = 'Loading live provider status from HostDeck…';
    const ordinal = ++requestedSerial, deviceAtStart = connection.deviceId();
    deviceReadiness.textContent = 'Checking HostDeck device readiness independently of provider health…';
    void readDeviceReadiness(endpoint, deviceAtStart).then(readiness => {
      if (!current() || connection.deviceId() !== deviceAtStart || ordinal !== requestedSerial) return;
      deviceReadiness.textContent = readiness === 'ready'
        ? 'HostDeck device is ready (device_status readback). Extensions remain separately unqualified.'
        : 'HostDeck device readiness is unknown. Provider status and qualifications remain separate.';
    });
    try {
      const value = assertProviderSnapshot(await endpoint('hostdeck_list_providers'));
      if (!current() || connection.deviceId() !== deviceAtStart || ordinal !== requestedSerial) return;
      snapshot = value; snapshotDevice = deviceAtStart; entries = mergeManagerCatalog(value);
      liveStatus.textContent = 'Live status read from HostDeck for this device. Research-only candidates remain unknown.';
    } catch (error) {
      if (!current() || ordinal !== requestedSerial) return;
      snapshot = null; snapshotDevice = ''; entries = mergeManagerCatalog({ providers: [], functions: [] });
      liveStatus.textContent = 'Live status unavailable: ' +
        (error instanceof Error ? error.message.slice(0, 180) : 'unknown error') +
        '. Research catalogue remains available without invented runtime observations.';
    } finally {
      busy = false; refreshButton.disabled = false;
      liveStatus.setAttribute('aria-busy', 'false');
      if (current() && ordinal === requestedSerial) {
        renderList(); if (tab === 'functions') renderFunctions();
      }
    }
  }
  for (const name of managerCategories(entries)) {
    const option = document.createElement('option'); option.value = name; option.textContent = name;
    category.append(option);
  }
  switchTab('library');
  renderList();
  void refresh();
}
