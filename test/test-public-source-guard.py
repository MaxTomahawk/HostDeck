"""Integration tests against Git and an installed Gitleaks; never use real credentials."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

GUARD = Path(__file__).resolve().parents[1] / 'scripts' / 'check-public-source.py'
GITLEAKS = os.environ.get('HOSTDECK_TEST_GITLEAKS', 'gitleaks')
TOKEN = 'ghp_' + 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL3oR6'


class PublicSourceGuardTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='hostdeck-public-guard-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '--quiet')
        self.git('config', 'user.name', 'HostDeck Test')
        self.git('config', 'user.email', 'test@example.invalid')

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.root, check=True, capture_output=True)

    def stage(self, name, text):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding='utf-8')
        self.git('add', '--', name)

    def run_guard(self, *args, scanner=GITLEAKS):
        result = subprocess.run([sys.executable, str(GUARD), '--gitleaks', scanner, *args],
                                cwd=self.root, capture_output=True, text=True)
        self.assertNotIn(TOKEN, result.stdout + result.stderr, 'secret leaked in diagnostics')
        return result

    def test_clean_stage_passes_and_untracked_files_are_out_of_scope(self):
        self.stage('README.md', 'HostDeck source\n')
        (self.root / 'untracked.txt').write_text(TOKEN, encoding='utf-8')
        result = self.run_guard()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_staged_secret_fails_even_if_worktree_is_cleaned(self):
        self.stage('example.txt', 'token=' + TOKEN + '\n')
        (self.root / 'example.txt').write_text('clean\n', encoding='utf-8')
        self.assertEqual(self.run_guard().returncode, 1)

    def test_private_filename_is_blocked_without_printing_contents(self):
        self.stage('.env.production', 'NOT_A_SECRET=example\n')
        self.assertEqual(self.run_guard().returncode, 1)

    def test_scanner_unavailable_fails_closed(self):
        self.stage('README.md', 'HostDeck\n')
        result = self.run_guard(scanner='hostdeck-nonexistent-gitleaks-executable')
        self.assertEqual(result.returncode, 2)
        self.assertIn('scanner unavailable', result.stderr.lower())

    def test_scanner_process_error_is_not_reported_as_secret_finding(self):
        # Python receives the guard's first scanner argument ('git') as a script.
        # This controlled failing process pins the exit contract without secrets.
        self.stage('git', 'import sys\nsys.exit(1)\n')
        result = self.run_guard(scanner=sys.executable)
        self.assertEqual(result.returncode, 2)
        self.assertIn('scanner failed', result.stderr.lower())

    def test_history_finds_removed_secret_despite_repository_ignore_settings(self):
        self.stage('example.txt', 'token=' + TOKEN + '\n')
        self.git('commit', '--quiet', '-m', 'fixture')
        self.git('rm', '--quiet', 'example.txt')
        self.stage('.gitleaks.toml', "[allowlist]\nregexes = ['.*']\n")
        self.stage('.gitleaksignore', '*\n')
        self.git('commit', '--quiet', '-m', 'remove fixture')
        self.assertEqual(self.run_guard('--scope', 'history').returncode, 1)

    def test_history_blocks_private_filename_in_unicode_directory(self):
        name = 'project-\u00e9/.env'
        self.stage(name, 'EXAMPLE=not-secret\n')
        self.git('commit', '--quiet', '-m', 'private filename fixture')
        self.git('rm', '--quiet', name)
        self.git('commit', '--quiet', '-m', 'remove private filename fixture')
        self.assertEqual(self.run_guard('--scope', 'history').returncode, 1)


if __name__ == '__main__':
    unittest.main()
