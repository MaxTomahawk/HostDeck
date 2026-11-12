"""Actual offline archives and refusal boundaries; no installed plugin changes."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class PluginPackageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='hostdeck-plugin-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        shutil.copytree(ROOT / 'plugin/hostdeck', self.source)
        self.output = self.root / 'template.zip'

    def run_package(self, output=None):
        return subprocess.run([sys.executable, str(ROOT / 'scripts/package-hostdeck-plugin.py'),
            '--source', str(self.source), '--output', str(output or self.output)],
            capture_output=True, text=True, timeout=15)

    def test_reproducible_exact_members_and_original_license(self):
        first = self.run_package()
        self.assertEqual(first.returncode, 0, first.stderr)
        data = self.output.read_bytes()
        proof = json.loads(first.stdout)
        self.assertEqual(proof['type'], 'UNRESOLVED_SOURCE_TEMPLATE')
        self.assertFalse(proof['uploaded'])
        second = self.root / 'second.zip'
        self.assertEqual(self.run_package(second).returncode, 0)
        self.assertEqual(data, second.read_bytes())
        self.assertEqual(proof['archive_sha256'], hashlib.sha256(data).hexdigest())
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual(len(archive.namelist()), 9)
            self.assertTrue(all(name.startswith('hostdeck/') for name in archive.namelist()))
            self.assertEqual(archive.read('hostdeck/LICENSE').decode(),
                             (ROOT / 'LICENSE').read_text().replace('\r\n', '\n'))
        self.assertEqual(self.run_package().returncode, 2)
        self.assertEqual(self.output.read_bytes(), data, 'existing ZIP must never change')

    def test_unlisted_hidden_file_cannot_enter_archive(self):
        (self.source / '.env').write_text('SYNTHETIC_PRIVATE_PAYLOAD')
        result = self.run_package()
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.output.exists())
        self.assertNotIn('SYNTHETIC_PRIVATE_PAYLOAD', result.stdout + result.stderr)

    def test_malformed_yaml_never_echoes_document_or_traceback(self):
        (self.source / 'skills/hostdeck-operations/SKILL.md').write_text(
            '---\nname: [SYNTHETIC_PRIVATE_PAYLOAD\ndescription: test\n---\nBody\n')
        result = self.run_package()
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.output.exists())
        self.assertNotIn('SYNTHETIC_PRIVATE_PAYLOAD', result.stdout + result.stderr)
        self.assertNotIn('Traceback', result.stderr)

    def test_broken_reference_and_private_connection_refused(self):
        reference = self.source / 'skills/hostdeck-operations/references/tools.md'
        reference.write_text('[outside](../../../../outside-private.md)\n')
        self.assertEqual(self.run_package().returncode, 2)
        self.assertFalse(self.output.exists())
        reference.write_bytes((ROOT / 'plugin/hostdeck/skills/hostdeck-operations/references/tools.md').read_bytes())
        connection = self.source / 'mcp.json'
        connection.write_text(connection.read_text().replace('${HOSTDECK_MCP_URL}', 'https://private.invalid/mcp'))
        self.assertEqual(self.run_package().returncode, 2)
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
