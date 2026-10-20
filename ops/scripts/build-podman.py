#!/usr/bin/env python3
"""Build deployment images using the same mirror arguments as Compose."""
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

import yaml


def build_images(root: Path) -> None:
    config = yaml.safe_load((root / 'ops/docker-compose.yml').read_text())
    # Build settings are single-line literal URLs/image names. Read only those
    # keys, never source .env as shell code or log runtime secrets.
    pattern = re.compile(r'\$\{([A-Z_]+):-([^}]*)\}')
    settings = set()
    for name in ('api', 'web'):
        for value in config['services'][name]['build'].get('args', {}).values():
            match = pattern.fullmatch(str(value))
            if match:
                settings.add(match[1])
    values = {}
    env_file = root / 'ops/.env'
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith('export '):
                line = line[7:]
            key, sep, value = line.partition('=')
            key = key.strip()
            if not sep or key not in settings:
                continue
            words = shlex.split(value, comments=True)
            if len(words) > 1:
                raise ValueError(f'{key}: build settings must be a single URL or image name')
            values[key] = words[0] if words else ''
    values.update({key: os.environ[key] for key in settings if key in os.environ})

    for name in ('api', 'web'):
        build = config['services'][name]['build']
        context = (root / 'ops' / build['context']).resolve()
        args = []
        for key, value in build.get('args', {}).items():
            match = pattern.fullmatch(str(value))
            if not match:
                raise ValueError(f'{key}: unsupported build argument expression')
            resolved = values.get(match[1]) or match[2]
            args.extend(['--build-arg', f'{key}={resolved}'])
        print(f'构建 {name}：复用镜像层和依赖下载缓存。', flush=True)
        subprocess.run([
            'podman', 'build', '--layers', '--pull=missing', *args,
            '-t', f'localhost/ops_{name}:latest',
            '-f', str(context / build.get('dockerfile', 'Dockerfile')),
            str(context),
        ], check=True)
        if name == 'api':
            subprocess.run([
                'podman', 'tag', 'localhost/ops_api:latest', 'localhost/ops_worker:latest',
            ], check=True)


if __name__ == '__main__':
    build_images(Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
