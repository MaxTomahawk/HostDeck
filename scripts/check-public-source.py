#!/usr/bin/env python3
"""Fail closed on public-source risks. Requires Git and Gitleaks v8 on PATH."""
import argparse
from pathlib import PurePosixPath
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def git(*args):
    return subprocess.check_output(['git', *args], stderr=subprocess.PIPE).decode('utf-8')


def private_filename(name):
    base = PurePosixPath(name).name.lower()
    return (base != '.env.example' and
            (base == '.env' or base.startswith('.env.') or
             base in {'id_rsa', 'id_ed25519', '.npmrc', 'credentials.json'} or
             bool(re.search(r'\.(pem|key|pfx|p12|kdbx)$', base))))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scope', choices=['staged', 'history'], default='staged',
                        help='staged index, or all reachable Git history before release')
    parser.add_argument('--gitleaks', default='gitleaks', help='Gitleaks v8 executable')
    args = parser.parse_args()
    try:
        root = git('rev-parse', '--show-toplevel').strip()
        if args.scope == 'staged':
            names = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0')
        else:
            names = git('log', '--all', '--format=', '--name-only', '-z').split('\0')
        blocked_names = sum(private_filename(name) for name in set(filter(None, names)))
        # Explicit default rules and an empty ignore file prevent repository allowlists
        # or inline gitleaks:allow comments from weakening publication checks.
        with tempfile.TemporaryDirectory(prefix='hostdeck-scan-') as folder:
            config = Path(folder) / 'rules.toml'
            ignore = Path(folder) / '.gitleaksignore'
            config.write_text('[extend]\nuseDefault = true\n', encoding='utf-8')
            ignore.write_text('', encoding='utf-8')
            result = subprocess.run([
                args.gitleaks, 'git', '--staged' if args.scope == 'staged' else '--log-opts=--all',
                '--config', str(config), '--gitleaks-ignore-path', str(ignore),
                '--ignore-gitleaks-allow', '--redact=100', '--exit-code=3', '--no-banner', '--no-color', root,
            ], capture_output=True)
        if result.returncode not in (0, 3):
            print('Scanner failed; publication blocked.', file=sys.stderr)
            return 2
        if blocked_names or result.returncode == 3:
            print(f'Publication blocked: {blocked_names} private filename(s); '
                  f'secret findings: {"yes" if result.returncode else "no"}.', file=sys.stderr)
            return 1
        print(f'Public-source {args.scope} checks passed (bounded filename/secret screening).')
        return 0
    except FileNotFoundError:
        print('Git or scanner unavailable; publication blocked.', file=sys.stderr)
        return 2
    except (OSError, subprocess.CalledProcessError, UnicodeError):
        print('Source inspection failed; publication blocked.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
