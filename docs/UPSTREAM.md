# Manual upstream review

Use `scripts/review-upstream.ps1` to compare already-fetched local refs without changing repository state. The script requires an explicit HostDeck fork ref under `refs/remotes/origin/` and an upstream ref under `refs/remotes/upstream/`; both must exist locally. It does not fetch, merge, inspect remote URLs, print commit subjects, or modify files.

For example, compare the currently cached main refs:

```powershell
./scripts/review-upstream.ps1 -HostRef refs/remotes/origin/main -UpstreamRef refs/remotes/upstream/main
```

The JSON report includes the resolved commit IDs, merge base, exact host-only and upstream-only counts, bounded commit-ID lists, and upstream changed paths from the merge base. Commit lists default to 100 IDs and may be increased to at most 500 with `-CommitLimit`. When the refs have unrelated histories or a ref is missing, the script stops instead of guessing a baseline.

This is a local comparison aid, not an update monitor or merge recommendation. Refs may be refreshed on demand as part of an authorized development or update review; then inspect relevant diffs, licenses, security implications and tests before proposing changes. Automatic upstream monitoring remains disabled until product acceptance and explicit owner activation.
