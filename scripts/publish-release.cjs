#!/usr/bin/env node
'use strict';

// HostDeck retains upstream MIT attribution in LICENSE. The former upstream
// release trigger is preserved in Git history, not executable in this product.
// Every legacy flag intentionally follows the same no-effect path.
process.stderr.write(
  'HostDeck release blocked: the inherited tag/CI/npm publisher is retired.\n' +
  'Use the reviewed local Windows package procedure in docs/WINDOWS.md.\n' +
  'Release requires reviewed tested main, complete acceptance and passing current/history privacy gates.\n' +
  'No files, versions, commits, tags, remotes or registries were changed.\n'
);
process.exitCode = 2;
