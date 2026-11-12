#!/usr/bin/env python3
"""Build an offline portable SOURCE TEMPLATE; never upload, connect or overwrite.

Requires Python 3 and PyYAML in the existing development environment.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = frozenset(('plugin.json', 'mcp.json', 'LICENSE', 'assets/hostdeck.svg',
    'skills/hostdeck-operations/SKILL.md',
    'skills/hostdeck-operations/references/tools.md',
    'skills/hostdeck-operations/references/contracts.md',
    'skills/hostdeck-operations/references/document-search.md',
    'skills/hostdeck-operations/references/connection.md'))
MAX_FILE, MAX_TOTAL = 1024 * 1024, 4 * 1024 * 1024


def refuse(condition):
    if condition:
        raise ValueError('SOURCE_TEMPLATE_INVALID')


def payloads(source):
    # Check ancestry and every directory before descent; never follow a junction.
    for part in (source, *source.parents):
        item = part.lstat()
        refuse(stat.S_ISLNK(item.st_mode) or getattr(item, 'st_file_attributes', 0) & 0x400)
    result, pending, entries, total = {}, [source], 0, 0
    while pending:
        for path in pending.pop().iterdir():
            entries += 1
            refuse(entries > 64)
            item = path.lstat()
            refuse(stat.S_ISLNK(item.st_mode) or getattr(item, 'st_file_attributes', 0) & 0x400)
            if stat.S_ISDIR(item.st_mode):
                relative = path.relative_to(source).as_posix() + '/'
                refuse(not any(name.startswith(relative) for name in FILES))
                pending.append(path)
            else:
                name = path.relative_to(source).as_posix()
                refuse(name not in FILES or not stat.S_ISREG(item.st_mode) or item.st_size > MAX_FILE)
                data = path.read_bytes()
                total += len(data)
                refuse(len(data) > MAX_FILE or total > MAX_TOTAL)
                # All allowed components are UTF-8 text; stable checkout line endings.
                result[name] = data.decode('utf-8-sig').replace('\r\n', '\n').encode('utf-8')
    refuse(set(result) != FILES)
    return result


def validate(files):
    import yaml  # No dependency installation or fallback parser with weaker rules.
    manifest = json.loads(files['plugin.json'])
    refuse(manifest.get('$schema') != 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
           or manifest.get('name') != 'hostdeck' or manifest.get('license') != 'MIT')
    refuse(not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', manifest.get('version', '')))
    interface = manifest['extensions']['com.openai']['interface']
    refuse(interface.get('logo') != './assets/hostdeck.svg'
           or interface.get('composerIcon') != './assets/hostdeck.svg')
    connection = json.loads(files['mcp.json'])
    refuse(connection != {
        '$schema': 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        'mcpServers': {'hostdeck': {'type': 'streamable-http', 'url': '${HOSTDECK_MCP_URL}',
            'extensions': {'com.openai': {'auth': {'type': 'oauth', 'client': {'mode': 'dcr'}}}}}}})
    skill = files['skills/hostdeck-operations/SKILL.md'].decode('utf-8')
    refuse(not skill.startswith('---\n') or '\n---\n' not in skill[4:])
    try:
        front = yaml.safe_load(skill[4:].split('\n---\n', 1)[0])
    except yaml.YAMLError:
        raise ValueError('SKILL_FRONTMATTER_INVALID') from None
    refuse(not isinstance(front, dict) or set(front) != {'name', 'description'}
           or front.get('name') != 'hostdeck-operations'
           or not isinstance(front.get('description'), str) or not front['description'].strip())
    for name, data in files.items():
        if name.endswith('.md'):
            for link in re.findall(r'\]\(([^)]+)\)', data.decode('utf-8')):
                if link.startswith(('https://', '#')):
                    continue
                resolved = os.path.normpath(str(Path(name).parent / link)).replace('\\', '/')
                refuse(resolved not in FILES)
    expected_license = (ROOT / 'LICENSE').read_text(encoding='utf-8-sig').replace('\r\n', '\n')
    refuse(files['LICENSE'].decode('utf-8') != expected_license)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'plugin/hostdeck')
    parser.add_argument('--output', type=Path, required=True, help='new ZIP outside the plugin source')
    args = parser.parse_args()
    try:
        source = Path(os.path.abspath(args.source))
        output = Path(os.path.abspath(args.output))
        refuse(output.is_relative_to(source) or output.suffix.lower() != '.zip')
        files = payloads(source)
        validate(files)
        # Exclusive creation, fixed ordering/timestamps/permissions; never update an archive.
        with output.open('xb') as stream:
            with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
                for name, data in sorted(files.items()):
                    entry = zipfile.ZipInfo('hostdeck/' + name, date_time=(1980, 1, 1, 0, 0, 0))
                    entry.create_system = 3
                    entry.external_attr = 0o100644 << 16
                    entry.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(entry, data)
        with zipfile.ZipFile(output) as archive:
            refuse(set(archive.namelist()) != {'hostdeck/' + name for name in files})
            refuse(any(archive.read('hostdeck/' + name) != data for name, data in files.items()))
        print(json.dumps({'type': 'UNRESOLVED_SOURCE_TEMPLATE', 'files': len(files),
            'archive_sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
            'uploaded': False, 'connection_changed': False}, separators=(',', ':')))
        return 0
    except FileExistsError:
        print('Plugin archive already exists; refused without overwriting.', file=sys.stderr)
    except ImportError:
        print('PyYAML unavailable; plugin validation refused.', file=sys.stderr)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        print('Plugin source validation or archive verification failed; no upload attempted.', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main())
