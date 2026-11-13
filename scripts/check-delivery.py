#!/usr/bin/env python3
"""Read-only, compact delivery checkpoint. Never executes tests or replays effects.

Exit 0: requested observations/integrity checks succeeded, NOT product acceptance.
Exit 1: retained evidence changed/missing. Exit 2: input or observation unavailable.
Private evidence stays outside Git; stdout contains no evidence contents or paths.
"""
import argparse
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import urllib.request


SCOPE_REF = '9db5140b6a80c8b9935510736608e41ad7d0c088'
SCOPE = (
    ('requirements', 'docs/delivery/REQUIREMENT_DELIVERY_MAP_140.csv', 'requirement_id', 140),
    ('policies', 'docs/delivery/POLICY_DELIVERY_MAP_8.csv', 'policy_clause_id', 8),
    ('everything', 'docs/delivery/EVERYTHING_ACCEPTANCE_18.csv', 'criterion_id', 18),
    ('quality', 'docs/research/batches/OWNER_ANSWERS_20261026_B005/'
     'R09_GLOBAL_QUALITY_17_CURRENT_B005.csv', 'gate_id', 17),
)
MAX_JSON = 4 * 1024 * 1024
MAX_PROOF = 16 * 1024 * 1024
HEX = re.compile(r'[0-9a-f]{64}\Z')


class CheckError(Exception):
    """Only fixed diagnostic codes reach stdout; never underlying exception text."""


def git(repo, *args):
    return subprocess.check_output(['git', *args], cwd=repo, stderr=subprocess.PIPE,
                                   timeout=30).decode('utf-8')


def regular(path, maximum):
    """Refuse links/reparse points on every existing component, not only the leaf."""
    path = Path(os.path.abspath(path))
    for part in (path, *path.parents):
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise CheckError('REPARSE_REFUSED')
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
        raise CheckError('FILE_BOUND_REFUSED')
    return path


def read_json(path):
    data = regular(path, MAX_JSON).read_bytes()
    if len(data) > MAX_JSON:
        raise CheckError('FILE_BOUND_REFUSED')
    return json.loads(data.decode('utf-8-sig'))


def digest(path, maximum=MAX_PROOF):
    path = regular(path, maximum)
    hasher, size = hashlib.sha256(), 0
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            if size > maximum:
                raise CheckError('FILE_BOUND_REFUSED')
            hasher.update(chunk)
    return size, hasher.hexdigest()


def proof_path(root, name):
    # Require portable relative names; reject Windows drive, UNC, ADS and traversal.
    if not isinstance(name, str) or not name or '\\' in name or ':' in name:
        raise CheckError('PROOF_PATH_REFUSED')
    parts = name.split('/')
    if PurePosixPath(name).is_absolute() or any(p in ('', '.', '..') for p in parts):
        raise CheckError('PROOF_PATH_REFUSED')
    return Path(root).joinpath(*parts)


def check_proofs(root, index):
    rows = index.get('proof_files')
    if not isinstance(rows, list) or not 1 <= len(rows) <= 1000:
        raise CheckError('PROOF_INDEX_INVALID')
    seen, matched, failures = set(), 0, []
    for ordinal, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            raise CheckError('PROOF_INDEX_INVALID')
        path = proof_path(root, row.get('path'))
        name = str(path).casefold()
        expected_size, expected_hash = row.get('bytes'), row.get('sha256')
        if (name in seen or type(expected_size) is not int or
                not 0 <= expected_size <= MAX_PROOF or
                not isinstance(expected_hash, str) or not HEX.fullmatch(expected_hash)):
            raise CheckError('PROOF_INDEX_INVALID')
        seen.add(name)
        try:
            size, actual_hash = digest(path)
            if (size, actual_hash) == (expected_size, expected_hash):
                matched += 1
            else:
                failures.append({'entry': ordinal, 'code': 'PROOF_CHANGED'})
        except FileNotFoundError:
            failures.append({'entry': ordinal, 'code': 'PROOF_MISSING'})
    return {'checked': len(rows), 'matched': matched, 'failures': failures,
            'meaning': 'retained bytes only; no result, signature or effect requalification'}


def scope_inventory(repo, ref):
    commit = git(repo, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}').strip()
    counts = {}
    for label, path, field, expected in SCOPE:
        rows = list(csv.DictReader(io.StringIO(git(repo, 'show', commit + ':' + path))))
        ids = [row.get(field) for row in rows]
        if len(ids) != expected or len(set(ids)) != expected or not all(ids):
            raise CheckError('SCOPE_INVENTORY_INVALID')
        counts[label] = expected
    return {'source_commit': commit, 'counts': counts,
            'meaning': 'original scope inventory, not accepted criteria counts'}


def live_status():
    if sys.platform != 'win32':
        raise CheckError('WINDOWS_REQUIRED')
    # Constant read-only query; never interpolate input into PowerShell code.
    script = "$s=Get-CimInstance Win32_Service -Filter \"Name='HostDeck'\" " \
        "-ErrorAction Stop; if($null -eq $s){throw 'missing'}; " \
        "@{state=[string]$s.State;start_mode=[string]$s.StartMode;pid=[int]$s.ProcessId}" \
        "|ConvertTo-Json -Compress"
    service = json.loads(subprocess.check_output(
        ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
        stderr=subprocess.PIPE, timeout=15).decode('utf-8-sig'))
    if (not isinstance(service, dict) or
            service.get('state') not in ('Running', 'Stopped', 'Start Pending', 'Stop Pending') or
            service.get('start_mode') not in ('Auto', 'Manual', 'Disabled') or
            type(service.get('pid')) is not int):
        raise CheckError('SERVICE_OBSERVATION_INVALID')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                        NoRedirect())
    with opener.open('http://127.0.0.1:18763/health', timeout=5) as response:
        health = json.loads(response.read(4097))
    if (not isinstance(health, dict) or health.get('product') != 'HostDeck' or
            health.get('status') != 'ready'):
        raise CheckError('HEALTH_NOT_READY')
    root = Path(os.environ['ProgramFiles']) / 'HostDeck'
    return {'service': service, 'http_health': 'ready',
            'installed_manifest_sha256': digest(root / 'current/manifest.json')[1],
            'installed_config_sha256': digest(root / 'config/facade.json')[1],
            'meaning': 'current service/health/identity observation; not full runtime acceptance'}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise CheckError('HEALTH_REDIRECT_REFUSED')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--scope-ref', default=SCOPE_REF)
    parser.add_argument('--proof-index', type=Path)
    parser.add_argument('--evidence-root', type=Path)
    parser.add_argument('--candidate-root', type=Path,
                        help='check manifest binding only, not all package payload bytes')
    parser.add_argument('--live', action='store_true', help='also read Windows service and health')
    args = parser.parse_args(argv)
    if bool(args.proof_index) != bool(args.evidence_root):
        parser.error('--proof-index and --evidence-root must be supplied together')
    if args.candidate_root and not args.proof_index:
        parser.error('--candidate-root requires --proof-index')
    report = {'schema': 'hostdeck-delivery-check-v1',
              'utc': datetime.now(timezone.utc).isoformat(),
              'full_goal_acceptance': 'NOT_DETERMINED', 'effects_replayed': 0}
    try:
        report['source_head'] = git(args.repo, 'rev-parse', 'HEAD').strip()
        records = iter(git(args.repo, 'status', '--porcelain=v1', '-z',
                           '--untracked-files=normal').split('\0'))
        changes = 0
        for record in records:
            if record:
                changes += 1
                if 'R' in record[:2] or 'C' in record[:2]:
                    next(records, None)  # rename/copy has a second pathname record
        report['changed_worktree_entries'] = changes
        report['scope'] = scope_inventory(args.repo, args.scope_ref)
        if args.proof_index:
            index = read_json(args.proof_index)
            if not isinstance(index, dict):
                raise CheckError('PROOF_INDEX_INVALID')
            report['retained_proofs'] = check_proofs(args.evidence_root, index)
            report['proof_index_sha256'] = digest(args.proof_index, MAX_JSON)[1]
            source = index.get('operative_package_source')
            if not isinstance(source, str) or not re.fullmatch(r'[0-9a-f]{40}', source):
                raise CheckError('PACKAGE_SOURCE_INVALID')
            paths = git(args.repo, 'diff', '--name-only', source, 'HEAD').splitlines()
            report['committed_changes_since_package'] = {
                'total': len(paths),
                'runtime_tree_paths': sum(p.startswith(('src/', 'ui/', 'windows/', 'plugin/'))
                                          for p in paths),
                'meaning': 'diff only; dependency/build inputs and worktree edits need review'}
            if args.candidate_root:
                expected = index.get('candidate_manifest_sha256')
                if not isinstance(expected, str) or not HEX.fullmatch(expected):
                    raise CheckError('CANDIDATE_HASH_INVALID')
                report['candidate_manifest_matches_checkpoint'] = (
                    digest(args.candidate_root / 'manifest.json')[1] == expected)
        if args.live:
            report['live'] = live_status()
        failed = bool(report.get('retained_proofs', {}).get('failures')) or (
            report.get('candidate_manifest_matches_checkpoint') is False)
        report['check'] = 'EVIDENCE_CHANGED' if failed else 'OBSERVATIONS_COMPLETE'
        code = 1 if failed else 0
    except CheckError as error:
        report['check'], report['error'] = 'UNAVAILABLE', str(error)
        code = 2
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        report['check'], report['error'] = 'UNAVAILABLE', 'INPUT_OR_OBSERVATION_FAILED'
        code = 2
    print(json.dumps(report, separators=(',', ':')))
    return code


if __name__ == '__main__':
    sys.exit(main())
