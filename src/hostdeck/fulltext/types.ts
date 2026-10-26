/**
 * HostDeck optional document full-text engine (HD-WP-05).
 * No index is created, nor is a root selected, until a caller explicitly
 * previews AND confirms an exact configuration digest.
 */
export type FullTextFormat = '.txt' | '.md' | '.csv' | '.json' | '.docx' | '.xlsx' | '.pdf';

export interface FullTextPrincipal {
  ownerId: string;
  deviceId: string;
  executorId: string;
  sessionId?: number;
}

export type FullTextAction =
  | 'preview' | 'configure' | 'storage' | 'scan' | 'index'
  | 'search' | 'snippet' | 'metadata' | 'status' | 'control';

export interface FullTextCheck {
  action: FullTextAction;
  /** Canonical path, never a caller-supplied display label. */
  path: string;
  root: string;
  principal: FullTextPrincipal;
}

/** Return exactly true for an allowed operation. Undefined is DENIED. */
export type FullTextAuthorizer = (request: FullTextCheck) => Promise<boolean>;

export interface FullTextBudgets {
  maxFileBytes: number;
  maxTotalSourceBytes: number;
  maxIndexBytes: number;
  minFreeDiskBytes: number;
  maxDocuments: number;
  maxDepth: number;
  maxEntriesPerDirectory: number;
  maxOperationsPerStep: number;
  maxStepMilliseconds: number;
  maxTextCharacters: number;
  minFreeMemoryBytes: number;
  maxQueryCandidates: number;
  maxResults: number;
}

export interface FullTextConfig {
  /** An existing, independently authorized state directory must contain this file. */
  indexFile: string;
  /** Selected absolute document directories; empty by default, never inferred. */
  roots: string[];
  /** Explicit eligible formats; never discover additional extractors silently. */
  formats: FullTextFormat[];
  budgets?: Partial<FullTextBudgets>;
  includeHidden?: boolean;
  /** Additional owner-selected absolute exclusion subtrees. */
  excludedRoots?: string[];
  /** Explicit opt-in for exact selected Windows FIXED volume roots, never inferred. */
  fixedVolumeRoots?: string[];
}

export type DocumentCoverage =
  | 'indexed' | 'unchanged' | 'unsupported_format' | 'size_limit'
  | 'text_limit' | 'ocr_required' | 'pdf_rtl_unqualified'
  | 'unsupported_office_value' | 'extraction_failed' | 'invalid_utf8';

export interface FullTextSearchResult {
  path: string;
  format: FullTextFormat;
  score: number; // FTS5 bm25: lower ranks first
  snippet: string;
  indexedAt: string;
  bytes: number;
  sha256: string;
  freshness: 'last_scan_only';
}

export interface FullTextSearchPage {
  results: FullTextSearchResult[];
  truncated: boolean;
  coverage: 'complete_bounded_scan' | 'partial_or_unverified';
  actualFreshness: 'not_monitored';
  querySemantics: 'unicode61_remove_diacritics_2_plus_exact_han';
}

export interface FullTextPreview {
  digest: string;
  roots: string[];
  formats: FullTextFormat[];
  excludedRoots: string[];
  fixedVolumeRoots: string[];
  budgets: FullTextBudgets;
  machine: { logicalCpus: number; totalMemoryMiB: number; freeMemoryMiB: number; gpuUsed: false };
  indexFile: string;
  activated: false;
  issues: string[];
  /** No result means the owner has not selected a document location. */
  requiresSelectedRoots: boolean;
}

export interface FullTextScanReceipt {
  state: 'running' | 'paused' | 'interrupted' | 'cancelled' | 'complete' | 'resource_paused';
  runId: string;
  processedThisStep: number;
  indexedThisStep: number;
  skippedThisStep: number;
  changedThisStep: number;
  renamedThisStep: number;
  removedAtCompletion: number;
  coverage: 'partial' | 'bounded_complete';
  reason?: string;
}
