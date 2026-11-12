/** Explicit document-index controls over the existing authorized MCP tools. */
import type { ManagerConnection } from './extension-manager.js';

const states = new Set(['unconfigured', 'selected_not_active', 'unstarted', 'running',
  'paused', 'interrupted', 'cancelled', 'complete', 'resource_paused']);
const runStates = new Set(['running', 'paused', 'interrupted', 'cancelled', 'complete', 'resource_paused']);
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, max = 2048): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const strings = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) && value.length <= max && value.every(item => bounded(item));

export interface IndexStatus {
  state: string;
  visibleDocuments?: number;
  coverage?: string;
  run: null | { runId: string; state: string; processed: number };
}
export interface IndexPreview {
  digest: string;
  roots: string[];
  formats: string[];
  excludedRoots: string[];
  budgets: Record<string, number>;
  issues: string[];
}

export function readIndexStatus(value: unknown): IndexStatus {
  if (!object(value) || !states.has(value.state)) throw new Error('INDEX_RESPONSE_INVALID');
  if (value.state === 'unconfigured' || value.state === 'selected_not_active')
    return { state: value.state, run: null };
  if (!count(value.visibleDocuments) ||
      !['partial_or_unverified', 'complete_bounded_scan'].includes(value.coverage))
    throw new Error('INDEX_RESPONSE_INVALID');
  let run: IndexStatus['run'] = null;
  if (value.run !== null) {
    if (!object(value.run) || !bounded(value.run.runId, 256) ||
        !runStates.has(value.run.state) || !count(value.run.processed) || value.run.state !== value.state)
      throw new Error('INDEX_RESPONSE_INVALID');
    run = { runId: value.run.runId, state: value.run.state, processed: value.run.processed };
  }
  if (value.state !== 'unstarted' && run === null) throw new Error('INDEX_RESPONSE_INVALID');
  return { state: value.state, run, visibleDocuments: value.visibleDocuments, coverage: value.coverage };
}

export function readIndexPreview(value: unknown): IndexPreview | null {
  if (object(value) && value.configured === false && value.reason === 'ROOTS_NOT_SELECTED') return null;
  if (!object(value) || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) ||
      value.activated !== false || !strings(value.roots, 128) || !strings(value.formats, 16) ||
      !strings(value.excludedRoots, 256) || !strings(value.issues, 64) || !object(value.budgets) ||
      Object.keys(value.budgets).length > 32 ||
      !Object.values(value.budgets).every(item => count(item))) throw new Error('INDEX_RESPONSE_INVALID');
  return { digest: value.digest, roots: [...value.roots], formats: [...value.formats],
    excludedRoots: [...value.excludedRoots], budgets: { ...value.budgets }, issues: [...value.issues] };
}

/** No timer, automatic activation, resume, mutation retry or root-selection API. */
export function mountDocumentIndex(host: HTMLElement, connection: ManagerConnection): void {
  const device = connection.deviceId();
  const current = () => host.isConnected && connection.isCurrent() && connection.deviceId() === device;
  const add = (parent: HTMLElement, tag: string, text?: string) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    parent.append(element); return element;
  };
  add(host, 'h3', 'Document content search');
  add(host, 'p', 'Review selected locations and limits before opening or starting an index. '
    + 'Scans run only on request. Results reflect the last scan; some document content may be unsupported.');
  const feedback = add(host, 'p', 'Read the current status or preview the selected locations.');
  feedback.className = 'manager-notice'; feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  const summary = add(host, 'dl'); summary.className = 'manager-dl';
  const previewBox = add(host, 'div');
  const actions = add(host, 'div'); actions.className = 'manager-actions';
  let status: IndexStatus | null = null;
  let preview: IndexPreview | null = null;
  let busy = false;
  let uncertain = false;
  const buttons: HTMLButtonElement[] = [];
  const button = (parent: HTMLElement, label: string, action: () => Promise<void>) => {
    const item = add(parent, 'button', label) as HTMLButtonElement;
    item.type = 'button'; buttons.push(item);
    item.addEventListener('click', () => { void execute(action); }); return item;
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    if (!current()) throw new Error('INDEX_CONTEXT_CHANGED');
    const result = await connection.call(name, args);
    if (!current()) throw new Error('INDEX_CONTEXT_CHANGED');
    return result;
  };
  const statusReadback = async () => {
    status = readIndexStatus(await call('hostdeck_fulltext_status'));
    uncertain = false;
    summary.replaceChildren();
    for (const [label, value] of [['State', status.state.replaceAll('_', ' ')],
      ['Visible indexed documents', String(status.visibleDocuments ?? 'Not available')],
      ['Coverage', status.coverage?.replaceAll('_', ' ') ?? 'Not available'],
      ['Processed this scan', String(status.run?.processed ?? 'Not available')]]) {
      add(summary, 'dt', label); add(summary, 'dd', value);
    }
  };
  const mutate = async (name: string, args: Record<string, unknown> = {}) => {
    // Set before dispatch: a transport failure may follow an actual effect.
    uncertain = true;
    await call(name, args);
    await statusReadback();
  };
  const refresh = button(actions, 'Read index status', async () => {
    status = null;
    await statusReadback();
    feedback.textContent = status!.state === 'unconfigured'
      ? 'No document locations selected. Select locations through protected local setup first.'
      : 'Current index status read from HostDeck.';
  });
  const review = button(actions, 'Preview locations and limits', async () => {
    preview = null; previewBox.replaceChildren();
    preview = readIndexPreview(await call('hostdeck_fulltext_preview'));
    if (!preview) {
      feedback.textContent = 'No document locations selected. No index has been opened or started.'; return;
    }
    for (const [label, values] of [['Selected locations', preview.roots],
      ['Excluded locations', preview.excludedRoots], ['Formats', preview.formats], ['Issues', preview.issues]] as const) {
      add(previewBox, 'h4', label);
      const list = add(previewBox, 'ul');
      for (const value of values) add(list, 'li', value);
      if (!values.length) add(list, 'li', 'None');
    }
    const limits = add(previewBox, 'dl'); limits.className = 'manager-dl';
    const labels: Record<string, string> = {
      maxFileBytes: 'Maximum bytes per file', maxTotalSourceBytes: 'Maximum source bytes',
      maxIndexBytes: 'Maximum index bytes', minFreeDiskBytes: 'Required free disk bytes',
      maxDocuments: 'Maximum documents', maxDepth: 'Maximum directory depth',
      maxEntriesPerDirectory: 'Maximum entries per directory', maxOperationsPerStep: 'Operations per step',
      maxStepMilliseconds: 'Maximum step milliseconds', maxTextCharacters: 'Maximum text characters per file',
      minFreeMemoryBytes: 'Required free memory bytes', maxQueryCandidates: 'Maximum query candidates',
      maxResults: 'Maximum results',
    };
    for (const [key, value] of Object.entries(preview.budgets)) {
      add(limits, 'dt', labels[key] ?? key); add(limits, 'dd', value.toLocaleString());
    }
    feedback.textContent = 'Preview read. Opening still requires the matching protected owner approval. '
      + 'Opening does not start a scan.';
  });
  const open = button(actions, 'Open approved index', async () => {
    if (!preview || !preview.roots.length || uncertain) return;
    const digest = preview.digest;
    preview = null;
    await mutate('hostdeck_fulltext_confirm', { digest });
    feedback.textContent = 'Approved index opened. Start or resume a scan explicitly.';
  });
  const start = button(actions, 'Start new scan', async () => {
    await mutate('hostdeck_fulltext_start'); feedback.textContent = 'Scan start acknowledged. Read status to check progress.';
  });
  const control = (operation: 'pause' | 'resume' | 'cancel', label: string) => button(actions, label, async () => {
    const run = status?.run;
    if (!run || uncertain) return;
    await mutate('hostdeck_fulltext_' + operation, { run_id: run.runId });
    feedback.textContent = 'Scan ' + operation + ' acknowledged. Read status to check the current result.';
  });
  const pause = control('pause', 'Pause scan');
  const resume = control('resume', 'Resume scan');
  const cancel = control('cancel', 'Cancel scan');
  add(host, 'p', 'Cancelling stops further work; it keeps already indexed content. '
    + 'This view does not change selected locations, permissions or external software.');
  const form = add(host, 'form');
  const label = add(form, 'label', 'Search indexed document text');
  const query = add(label, 'input') as HTMLInputElement;
  query.type = 'search'; query.minLength = 2; query.maxLength = 256; query.required = true;
  query.autocomplete = 'off'; query.name = 'document-query';
  const search = add(form, 'button', 'Search documents') as HTMLButtonElement;
  search.type = 'submit'; buttons.push(search);
  const results = add(host, 'div'); results.setAttribute('aria-label', 'Document search results');
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (query.value.length < 2 || query.value.length > 256 || search.disabled) return;
    void execute(async () => {
      results.replaceChildren();
      const value = await call('hostdeck_fulltext_query', { query: query.value, limit: 10 });
      if (!object(value) || !Array.isArray(value.results) || value.results.length > 10 ||
          typeof value.truncated !== 'boolean' ||
          !['complete_bounded_scan', 'partial_or_unverified'].includes(value.coverage) ||
          !value.results.every((item: unknown) => object(item) && bounded(item.path) &&
            typeof item.snippet === 'string' && item.snippet.length <= 16384 &&
            ['qualified_text', 'partial', 'unqualified', 'legacy_unverified'].includes(item.documentCoverage)))
        throw new Error('INDEX_RESPONSE_INVALID');
      add(results, 'p', value.results.length + ' results · ' + value.coverage.replaceAll('_', ' ')
        + (value.truncated ? ' · More matches may exist.' : '') + ' · Last scan only.');
      for (const item of value.results) {
        const article = add(results, 'article'); article.className = 'manager-entry';
        add(article, 'h4', item.path); add(article, 'p', item.snippet);
        add(article, 'p', 'Document coverage: ' + item.documentCoverage.replaceAll('_', ' '));
      }
      feedback.textContent = 'Search complete. Results are limited to currently authorized indexed content.';
    });
  });
  function updateButtons(): void {
    if (!current()) {
      status = null; preview = null;
      summary.replaceChildren(); previewBox.replaceChildren(); results.replaceChildren();
      feedback.textContent = 'Device or view changed. Reopen Document content for the selected device.';
    }
    const disabled = busy || !current();
    for (const item of buttons) item.disabled = disabled;
    if (disabled) return;
    const active = status && !['unconfigured', 'selected_not_active'].includes(status.state);
    open.disabled = uncertain || !preview?.roots.length || !!active || !!preview?.issues.length;
    start.disabled = uncertain || !active || !['unstarted', 'complete', 'cancelled'].includes(status!.state);
    pause.disabled = uncertain || status?.run?.state !== 'running';
    resume.disabled = uncertain || !['paused', 'interrupted', 'resource_paused'].includes(status?.run?.state ?? '');
    cancel.disabled = uncertain || !['running', 'paused', 'interrupted', 'resource_paused'].includes(status?.run?.state ?? '');
    search.disabled = !active || uncertain;
    refresh.disabled = false; review.disabled = false;
  }
  async function execute(action: () => Promise<void>): Promise<void> {
    if (busy || !current()) { updateButtons(); return; }
    busy = true; host.setAttribute('aria-busy', 'true'); updateButtons();
    feedback.textContent = 'Waiting for HostDeck…';
    try { await action(); }
    catch {
      if (current()) feedback.textContent = uncertain
        ? 'The change could not be verified. Read current status before another action; the request was not retried.'
        : 'The request is unavailable or its response could not be verified. Check connection and permissions, then read status.';
    } finally {
      busy = false; host.setAttribute('aria-busy', 'false'); updateButtons();
    }
  }
  updateButtons();
}
