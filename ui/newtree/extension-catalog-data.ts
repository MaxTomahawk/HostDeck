/** Public-safe B007 catalogue extract. NO runtime/device, installed, enabled, healthy,
 * licence grant, qualification or app authorization is asserted by this file.
 * Source: private R05 unified 79 candidate index 13b98471d10f753d0b7d2236d44144fe8cd7b4ea and
 * private delivery map 69f28dc667f690b2a08a4c9c5f6be276907bdbdf (read-only, pinned e1353f01e48140bcafa12866c99e414b8844137f).
 * Research version observations refer to upstream, NOT the local machine.
 * The candidate identity/list is fixed; live status is joined only from
 * current authenticated hostdeck_list_providers results at runtime.
 */
export interface ExtensionCandidate {
  id: string;
  name: string;
  category: string;
  origin: string;
  upstreamVersionObservation: string;
  licenseResearchHint: string;
  researchDisposition: string;
  researchQualification: string;
  ownerPriority: boolean;
  capabilityHints: readonly string[];
}
export const EXTENSION_CANDIDATES: readonly ExtensionCandidate[] = Object.freeze([
  {
    "id": "EXT-CAND-0001",
    "name": "Everything",
    "category": "File name/metadata",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "1.4.1.1032",
    "licenseResearchHint": "Proprietary",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": true,
    "capabilityHints": [
      "files.name"
    ]
  },
  {
    "id": "EXT-CAND-0002",
    "name": "Windows Search",
    "category": "File name/metadata",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "Windows component; no separate product semver",
    "licenseResearchHint": "Windows terms",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": [
      "files.name"
    ]
  },
  {
    "id": "EXT-CAND-0003",
    "name": "fd",
    "category": "File name/metadata",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "v10.5.0",
    "licenseResearchHint": "Apache-2.0 / MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": [
      "files.name"
    ]
  },
  {
    "id": "EXT-CAND-0004",
    "name": "WizFile",
    "category": "File name/metadata",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "3.15",
    "licenseResearchHint": "Proprietary",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": [
      "files.name"
    ]
  },
  {
    "id": "EXT-CAND-0005",
    "name": "Agent Ransack / FileLocator",
    "category": "File name/metadata",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "2022 build 3566",
    "licenseResearchHint": "Proprietary",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": [
      "files.name"
    ]
  },
  {
    "id": "EXT-CAND-0006",
    "name": "SearchMyFiles",
    "category": "File name/metadata",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "3.36",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": [
      "files.name"
    ]
  },
  {
    "id": "EXT-CAND-0007",
    "name": "ripgrep",
    "category": "Text/content",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "15.2.0",
    "licenseResearchHint": "MIT / Unlicense",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": [
      "files.content"
    ]
  },
  {
    "id": "EXT-CAND-0008",
    "name": "PowerGREP",
    "category": "Text/content",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "5.4.1",
    "licenseResearchHint": "Proprietary",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": [
      "files.content"
    ]
  },
  {
    "id": "EXT-CAND-0009",
    "name": "DocFetcher",
    "category": "Text/content",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "1.1.27",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": [
      "files.content"
    ]
  },
  {
    "id": "EXT-CAND-0010",
    "name": "Recoll",
    "category": "Text/content",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "1.45.0 (Windows and source page)",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": [
      "files.content"
    ]
  },
  {
    "id": "EXT-CAND-0011",
    "name": "SQLite FTS5",
    "category": "Text/content",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "SQLite3.54.1; FTS5 availability is build-specific",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": [
      "files.content"
    ]
  },
  {
    "id": "EXT-CAND-0012",
    "name": "Lucene",
    "category": "Text/content",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "releases/lucene/10.5.2",
    "licenseResearchHint": "Apache-2.0",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": [
      "files.content"
    ]
  },
  {
    "id": "EXT-CAND-0013",
    "name": "Tantivy",
    "category": "Text/content",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "0.26.1",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": [
      "files.content"
    ]
  },
  {
    "id": "EXT-CAND-0014",
    "name": "Xapian",
    "category": "Text/content",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "2.1.0",
    "licenseResearchHint": "GPL",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": [
      "files.content"
    ]
  },
  {
    "id": "EXT-CAND-0015",
    "name": "sqlite-vec",
    "category": "Semantic retrieval",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "0.1.9",
    "licenseResearchHint": "Apache-2.0 / MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0016",
    "name": "LanceDB",
    "category": "Semantic retrieval",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "0.40.0",
    "licenseResearchHint": "Apache-2.0",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0017",
    "name": "Qdrant",
    "category": "Semantic retrieval",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "1.20.0",
    "licenseResearchHint": "Apache-2.0 / Proprietary",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0018",
    "name": "FAISS",
    "category": "Semantic retrieval",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "1.15.1",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0019",
    "name": "Ollama embeddings",
    "category": "Semantic retrieval",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "0.40.9",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0020",
    "name": "FastEmbed",
    "category": "Semantic retrieval",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "0.9.0",
    "licenseResearchHint": "Apache-2.0",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0021",
    "name": "Git",
    "category": "Code and Git",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "v2.56.0.windows.3",
    "licenseResearchHint": "GPL",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0022",
    "name": "GitHub CLI",
    "category": "Code and Git",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "v2.103.1",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0023",
    "name": "DevSpace",
    "category": "Code and Git",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "v1.0.8",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0024",
    "name": "ast-grep",
    "category": "Code and Git",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "0.51.0",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0025",
    "name": "tree-sitter",
    "category": "Code and Git",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "v0.27.1",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0026",
    "name": "Semgrep",
    "category": "Code and Git",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "v1.182.0",
    "licenseResearchHint": "LGPL / Proprietary",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0027",
    "name": "Universal Ctags",
    "category": "Code and Git",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "v6.2.1",
    "licenseResearchHint": "GPL",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0028",
    "name": "Difftastic",
    "category": "Code and Git",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "0.71.0",
    "licenseResearchHint": "Apache-2.0 / MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0029",
    "name": "delta",
    "category": "Code and Git",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "0.20.1",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0030",
    "name": "Git LFS",
    "category": "Code and Git",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "v3.8.1",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0031",
    "name": "PowerToys Command Palette",
    "category": "Windows UI",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "v0.102.2933.0",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0032",
    "name": "PowerToys Dock",
    "category": "Windows UI",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "v0.102.2933.0",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0033",
    "name": "PowerToys Advanced Paste CLI",
    "category": "Windows UI",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "v0.102.2933.0",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0034",
    "name": "PowerToys FancyZones",
    "category": "Windows UI",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "v0.102.2933.0",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0035",
    "name": "AutoHotkey v2",
    "category": "Windows UI",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "v2.0.30",
    "licenseResearchHint": "GPL",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0036",
    "name": "FlaUI",
    "category": "Windows UI",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "v5.0.0",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0037",
    "name": "pywinauto",
    "category": "Windows UI",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "0.6.9",
    "licenseResearchHint": "BSD / LGPL",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0038",
    "name": "Power Automate Desktop",
    "category": "Windows UI",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "2610; installer2.73.155.26278; Store11.2610.155.0",
    "licenseResearchHint": "Proprietary",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0039",
    "name": "Windows UI Automation API",
    "category": "Windows UI",
    "origin": "R05A-B004",
    "upstreamVersionObservation": "",
    "licenseResearchHint": "MIT / Windows terms",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0040",
    "name": "Windows native OCR",
    "category": "Windows UI",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0041",
    "name": "Windows Notifications",
    "category": "Windows UI",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "Windows App SDK stable2.5.1; OS-shellvariant apart",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0042",
    "name": "Playwright",
    "category": "Browser",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "v1.64.1",
    "licenseResearchHint": "Apache-2.0",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0043",
    "name": "Chromium CDP",
    "category": "Browser",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "devtools-protocol masterpackage0.0.1724436; werkelijk browserprotocol apart te ontdekken",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0044",
    "name": "Selenium WebDriver",
    "category": "Browser",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "selenium-4.51.0",
    "licenseResearchHint": "Apache-2.0",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0045",
    "name": "Windows Event Log",
    "category": "Diagnostics",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "Windows Event Log OS-component; live OSreported10.0.26220.0, API niet apart geverifieerd",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0046",
    "name": "Sysinternals Process Explorer",
    "category": "Diagnostics",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "17.2",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0047",
    "name": "Sysinternals Process Monitor",
    "category": "Diagnostics",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "4.12",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0048",
    "name": "Sysinternals Handle",
    "category": "Diagnostics",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "5.0",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0049",
    "name": "Sysinternals Autoruns",
    "category": "Diagnostics",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "14.3",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0050",
    "name": "Sysinternals TCPView",
    "category": "Diagnostics",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "4.19",
    "licenseResearchHint": "Proprietary",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0051",
    "name": "WPR/WPA ETW",
    "category": "Diagnostics",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "Live wpr.exe10.0.26100.9739; actuele ADK 10.1.26100.9457 is afzonderlijke distributie",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0052",
    "name": "PerfMon",
    "category": "Diagnostics",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "Live perfmon.exe product/file10.00; OSreported10.0.26220.0",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0053",
    "name": "WinDbg",
    "category": "Diagnostics",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "1.2610.1001.0",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0054",
    "name": "WinGet",
    "category": "Package manager",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "v1.29.380",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0055",
    "name": "Scoop",
    "category": "Package manager",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "v0.6.0",
    "licenseResearchHint": "MIT / Unlicense",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0056",
    "name": "Chocolatey",
    "category": "Package manager",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "2.7.4",
    "licenseResearchHint": "Apache-2.0",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0057",
    "name": "MSIX/App Installer",
    "category": "Package manager",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0058",
    "name": "UniGetUI",
    "category": "Package manager",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "v2026.3.2",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0059",
    "name": "Pandoc",
    "category": "Documents",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "3.12.1",
    "licenseResearchHint": "GPL",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0060",
    "name": "LibreOffice headless",
    "category": "Documents",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "26.8.1",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0061",
    "name": "Poppler pdftotext",
    "category": "Documents",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "26.10.0",
    "licenseResearchHint": "GPL",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0062",
    "name": "MuPDF",
    "category": "Documents",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "1.28.5",
    "licenseResearchHint": "GPL / Proprietary",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0063",
    "name": "qpdf",
    "category": "Documents",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "v12.4.2",
    "licenseResearchHint": "Apache-2.0",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0064",
    "name": "Calibre",
    "category": "Documents",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "v9.17.0",
    "licenseResearchHint": "GPL",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0065",
    "name": "Tesseract OCR",
    "category": "Media",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "5.5.3",
    "licenseResearchHint": "Apache-2.0",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0066",
    "name": "FFmpeg/ffprobe",
    "category": "Media",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0067",
    "name": "ExifTool",
    "category": "Media",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "13.59 development;13.55 laatste production volgens Changes",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0068",
    "name": "ImageMagick",
    "category": "Media",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "7.1.2-34",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0069",
    "name": "whisper.cpp",
    "category": "Media",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "v1.9.5",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0070",
    "name": "7-Zip",
    "category": "Archives",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "26.05",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0071",
    "name": "DuckDB",
    "category": "Data",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "v2.0.0",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0072",
    "name": "jq",
    "category": "Data",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "jq-1.8.2",
    "licenseResearchHint": "MIT",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0073",
    "name": "Miller",
    "category": "Data",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "v6.22.0",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0074",
    "name": "PowerShell 7",
    "category": "Connectivity",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "v7.6.8",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0075",
    "name": "OpenSSH for Windows",
    "category": "Connectivity",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "10.4.0.0p1-Preview",
    "licenseResearchHint": "BSD",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0076",
    "name": "curl",
    "category": "Connectivity",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "Live bestandsversie8.22.0; upstreamWindows8.23.0_5",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0077",
    "name": "Wireshark/tshark",
    "category": "Connectivity",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "4.6.9 stable;4.4.19 oldstable;5.0.0rc1 development",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0078",
    "name": "rclone",
    "category": "Connectivity",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "v1.75.2",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  },
  {
    "id": "EXT-CAND-0079",
    "name": "restic",
    "category": "Connectivity",
    "origin": "R05B-B003",
    "upstreamVersionObservation": "v0.19.1",
    "licenseResearchHint": "Not classified",
    "researchDisposition": "RESEARCH_ONLY",
    "researchQualification": "NOT_TESTED",
    "ownerPriority": false,
    "capabilityHints": []
  }
]);
