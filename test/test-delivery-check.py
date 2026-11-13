"""Safety/meaning checks for the resumable read-only delivery summary."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/check-delivery.py'
SPEC = importlib.util.spec_from_file_location('delivery_check', SCRIPT)
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class DeliveryCheckTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='hostdeck-check-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = b'original failed run retained; not a new PASS'
        (self.root / 'retained.txt').write_bytes(self.data)
        self.row = {'path': 'retained.txt', 'bytes': len(self.data),
                    'sha256': hashlib.sha256(self.data).hexdigest()}

    def check(self, rows=None):
        return CHECK.check_proofs(self.root, {'proof_files': rows or [self.row]})

    def test_failed_test_bytes_can_match_without_becoming_accepted(self):
        result = self.check()
        self.assertEqual((result['matched'], result['failures']), (1, []))
        self.assertIn('no result', result['meaning'])
        self.assertEqual((self.root / 'retained.txt').read_bytes(), self.data)

    def test_changed_or_missing_retained_proof_does_not_pass(self):
        (self.root / 'retained.txt').write_bytes(b'changed')
        self.assertEqual(self.check()['failures'], [{'entry': 1, 'code': 'PROOF_CHANGED'}])
        (self.root / 'retained.txt').unlink()
        self.assertEqual(self.check()['failures'], [{'entry': 1, 'code': 'PROOF_MISSING'}])

    def test_escape_paths_rejected_before_file_access(self):
        for name in ('../outside', 'x/../outside', '/absolute', 'C:/outside',
                     '//server/share', 'a\\b', 'a:stream', 'a//b', './x', ''):
            with self.subTest(name=name), patch.object(CHECK, 'digest') as read:
                with self.assertRaises(CHECK.CheckError):
                    self.check([{**self.row, 'path': name}])
                read.assert_not_called()

    def test_duplicates_wrong_hashes_sizes_and_empty_inventory_fail_closed(self):
        for rows in ([], [self.row, {**self.row, 'path': 'RETAINED.TXT'}],
                     [{**self.row, 'sha256': 'not a digest'}],
                     [{**self.row, 'bytes': True}],
                     [{**self.row, 'bytes': CHECK.MAX_PROOF + 1}]):
            with self.subTest(rows=rows), self.assertRaises(CHECK.CheckError):
                CHECK.check_proofs(self.root, {'proof_files': rows})

    def test_reparse_point_is_refused(self):
        actual = (self.root / 'retained.txt').lstat()
        class Reparse:
            st_mode = actual.st_mode
            st_file_attributes = 0x400
        with patch.object(Path, 'lstat', return_value=Reparse()):
            with self.assertRaisesRegex(CHECK.CheckError, 'REPARSE_REFUSED'):
                CHECK.regular(self.root / 'retained.txt', CHECK.MAX_PROOF)

    def test_health_redirect_is_never_followed(self):
        with self.assertRaisesRegex(CHECK.CheckError, 'HEALTH_REDIRECT_REFUSED'):
            CHECK.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://example.invalid')

    def test_cli_uses_actual_git_and_keeps_acceptance_undetermined(self):
        def git(*args):
            return subprocess.check_output(['git', *args], cwd=self.root, stderr=subprocess.PIPE)
        git('init', '-q')
        git('config', 'user.name', 'Fixture')
        git('config', 'user.email', 'fixture@example.invalid')
        for label, name, column, count in CHECK.SCOPE:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(column + '\n' + '\n'.join(f'{label}-{n}' for n in range(count)) + '\n')
        git('add', '.')
        git('commit', '-qm', 'scope fixture')
        source = git('rev-parse', 'HEAD').decode().strip()
        index = self.root / 'proof-index.json'
        index.write_text(json.dumps({'proof_files': [self.row], 'operative_package_source': source}))
        command = [sys.executable, str(SCRIPT), '--repo', str(self.root), '--scope-ref', source,
                   '--evidence-root', str(self.root), '--proof-index', str(index)]
        success = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(success.returncode, 0, success.stderr)
        report = json.loads(success.stdout)
        self.assertEqual(report['scope']['counts'],
                         {'requirements': 140, 'policies': 8, 'everything': 18, 'quality': 17})
        self.assertEqual(report['full_goal_acceptance'], 'NOT_DETERMINED')
        self.assertEqual(report['effects_replayed'], 0)
        (self.root / 'retained.txt').write_text('private value must never be printed')
        failed = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(failed.returncode, 1)
        self.assertNotIn('private value', failed.stdout + failed.stderr)
        self.assertNotIn(str(self.root), failed.stdout + failed.stderr)
        self.assertEqual(json.loads(failed.stdout)['check'], 'EVIDENCE_CHANGED')


if __name__ == '__main__':
    unittest.main()
