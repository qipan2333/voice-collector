"""Exercise deployment sequencing/failure handling without accessing real containers."""
import json
import os
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[2]
STUB = '''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
name = pathlib.Path(sys.argv[0]).name
with open(os.environ['COMMAND_LOG'], 'a') as f: f.write(json.dumps([name, *args]) + '\\n')
fail = os.environ.get('FAIL_STAGE')
if name == 'sleep': sys.exit(0)
if name == 'podman-compose':
    print('PRIVATE_ENV_VALUE')
    sys.exit(0)
if args[:1] == ['inspect']:
    if '--format' in args:
        fmt=args[args.index('--format')+1]
        print('true' if 'Running' in fmt else 'new-image' if fmt == '{{.Image}}' else 'old-image')
    else:
        root=os.environ['TEST_PROJECT']
        db=args[1]=='ops_db_1'
        print(json.dumps([{'Config': {'Labels': {'com.docker.compose.project': 'ops'}}, 'Mounts': [{'Source': root + ('/postgres-data' if db else '/data'), 'Destination': '/var/lib/postgresql/data' if db else '/srv/voice-collector'}]}]))
elif args[:2] == ['image', 'inspect']: print('new-image')
elif args[:1] == ['build'] and fail == 'build': sys.exit(1)
elif args[:1] == ['exec']:
    if 'psql' in args: print('0')
    elif 'pg_dump' in args:
        if fail == 'backup': sys.exit(1)
        print('backup data')
    elif 'pg_restore' in args: sys.stdin.read(); print('backup contents')
    elif 'curl' in args and fail == 'health': sys.exit(1)
'''


def run_deploy(tmp_path, failure=None):
    project = tmp_path / 'project'
    project.mkdir()
    for folder in ['ops', 'data', 'postgres-data', 'apps/api', 'apps/web']:
        (project / folder).mkdir(parents=True, exist_ok=True)
    (project / 'ops/.env').write_text('APP_SECRET=test\n')
    (project / 'ops/docker-compose.yml').write_text((ROOT / 'ops/docker-compose.yml').read_text())
    (project / '.gitignore').write_text('ops/.env\ndata/\npostgres-data/\n')
    def git(*args):
        return subprocess.check_output(['git', '-C', str(project), *args], text=True).strip()
    git('init', '-q')
    git('config', 'user.name', 'Deployment test')
    git('config', 'user.email', 'test@example.invalid')
    git('add', '.')
    git('commit', '-qm', 'initial')
    commit = git('rev-parse', 'HEAD')
    bundle = tmp_path / 'source.bundle'
    git('bundle', 'create', str(bundle), 'HEAD')
    binaries = tmp_path / 'bin'
    binaries.mkdir()
    # Use the test interpreter, which has PyYAML installed.
    (binaries / 'python3').symlink_to(os.sys.executable)
    for name in ['podman', 'podman-compose', 'sleep']:
        script = binaries / name
        script.write_text(STUB)
        script.chmod(0o755)
    log = tmp_path / 'commands.jsonl'
    env = {**os.environ, 'PATH': f'{binaries}:{os.environ["PATH"]}', 'TEST_PROJECT': str(project), 'COMMAND_LOG': str(log), 'DEPLOY_LOCK_FILE': str(tmp_path / 'deploy.lock'), 'FAIL_STAGE': failure or ''}
    result = subprocess.run(['bash', str(ROOT / 'ops/scripts/deploy-podman.sh'), 'deploy', str(project), str(bundle), commit], env=env, capture_output=True, text=True)
    commands = [json.loads(line) for line in log.read_text().splitlines()]
    return result, commands, tmp_path


def test_deploy_orders_backup_migration_and_services(tmp_path):
    result, commands, root = run_deploy(tmp_path)
    assert result.returncode == 0, result.stderr
    assert 'PRIVATE_ENV_VALUE' not in result.stdout + result.stderr
    assert not any(c[1] in ['stop', 'rm'] and 'ops_db_1' in c for c in commands)
    dump = next(i for i,c in enumerate(commands) if 'pg_dump' in c)
    up = [(i,c) for i,c in enumerate(commands) if c[0] == 'podman-compose' and 'up' in c]
    assert dump < up[0][0] < up[1][0]
    assert up[0][1][-1] == 'api'
    assert up[1][1][-2:] == ['worker', 'web']
    import yaml
    config = yaml.safe_load(next(root.glob('voice-collector-backup-*/compose.yml')).read_text())
    assert all('depends_on' not in service for service in config['services'].values())
    assert config['services']['db']['volumes'][0].startswith(str(root / 'project/postgres-data'))
    assert next(root.glob('voice-collector-backup-*/database.dump')).stat().st_size > 0


@pytest.mark.parametrize('failure', ['build', 'backup', 'health'])
def test_failure_never_reports_success_and_only_restarts_before_migration(tmp_path, failure):
    result, commands, _ = run_deploy(tmp_path, failure)
    assert result.returncode != 0
    assert '部署成功' not in result.stdout
    restarted = any(c[:2] == ['podman', 'start'] for c in commands)
    assert restarted == (failure == 'backup')
    if failure == 'build':
        assert not any(c[:2] == ['podman', 'stop'] for c in commands)
    if failure == 'health':
        assert not any(c[0] == 'podman-compose' and c[-2:] == ['worker', 'web'] for c in commands)
