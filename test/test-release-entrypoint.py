"""Run every npm release entry point with external effects trapped."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ReleaseEntrypointTest(unittest.TestCase):
    def test_all_legacy_modes_refuse_without_commands_or_file_changes(self):
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Node is required; do not silently skip the release gate')
        scripts = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['scripts']
        modes = [value.split()[2:] for name, value in scripts.items()
                 if name == 'release' or name.startswith('release:')]
        self.assertEqual(len(modes), 6)
        modes += [['--yes', '--skip-tests'], ['--alpha', '--yes'], ['--major', '--dry-run']]
        with tempfile.TemporaryDirectory(prefix='hostdeck-release-guard-') as folder:
            fixture = Path(folder)
            trap = fixture / 'trap.cjs'
            trap.write_text("""
const cp = require('node:child_process');
for (const name of ['exec','execFile','execSync','execFileSync','spawn','spawnSync','fork'])
  cp[name] = () => { throw new Error('UNEXPECTED_EXTERNAL_COMMAND'); };
for (const api of [require('node:http'), require('node:https')])
  for (const name of ['get','request'])
    api[name] = () => { throw new Error('UNEXPECTED_NETWORK'); };
""", encoding='utf-8')
            (fixture / 'package.json').write_text('{"version":"0.0.0-fixture"}')
            def snapshot():
                return {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                        for p in fixture.iterdir() if p.is_file()}
            before = snapshot()
            for flags in modes:
                with self.subTest(flags=flags):
                    result = subprocess.run(
                        [node, '--require', str(trap), str(ROOT / 'scripts/publish-release.cjs'), *flags],
                        cwd=fixture, capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertIn('inherited tag/CI/npm publisher is retired', result.stderr)
                    self.assertNotIn('UNEXPECTED_', result.stdout + result.stderr)
                    self.assertEqual(snapshot(), before)


if __name__ == '__main__':
    unittest.main()
