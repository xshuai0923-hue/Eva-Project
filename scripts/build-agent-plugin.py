#!/usr/bin/env python3
"""Build a deterministic, credential-free plugin download from its allowlisted source."""
from pathlib import Path
import hashlib, json, zipfile
ROOT = Path(__file__).resolve().parents[1]
source = ROOT / 'plugins/eva-project'
output = ROOT / 'deploy/openproject/assets/agent-plugin'
output.mkdir(parents=True, exist_ok=True)
archive = output / 'eva-project.zip'
allowed = ['.codex-plugin', '.claude-plugin', '.mcp.json', 'skills', 'scripts', 'assets', 'templates', 'README.md']
files = []
for item in allowed:
    path = source / item
    files.extend([path] if path.is_file() else [p for p in path.rglob('*') if p.is_file()])
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
    for path in sorted(files):
        if path.is_symlink():
            raise ValueError(f'Symlinks are not distributable: {path}')
        info = zipfile.ZipInfo('eva-project/' + path.relative_to(source).as_posix(), (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        bundle.writestr(info, path.read_bytes())
manifest = json.loads((source / '.codex-plugin/plugin.json').read_text())
(output / 'release.json').write_text(json.dumps({'name': manifest['name'], 'version': manifest['version'], 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}, indent=2) + '\n')
print(f'Built {archive.relative_to(ROOT)} ({archive.stat().st_size} bytes)')

for path in sorted((source / 'templates').glob('*.md')):
    (output / path.name).write_bytes(path.read_bytes())
