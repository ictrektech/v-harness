#!/usr/bin/env python3
"""生成 docker-archive 格式的镜像归档（docker load 可直接导入）。

受限的 docker 能力可能不开放 GET /images/get（docker save 的后端接口），
但通常允许 docker create/export。本脚本用导出的根文件系统 + 镜像配置，
拼出一个等价的镜像归档，供 VOS 离线包使用。

用法：python3 ictrek.app/scripts/export-image.py <image-ref> <output.tar.gz>
"""
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import uuid


def run(cmd, **kwargs):
    proc = subprocess.run(cmd, capture_output=True, text=True, **kwargs)
    if proc.returncode != 0:
        raise SystemExit(f"[ERROR] {' '.join(cmd)} failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    ref, out_path = sys.argv[1], sys.argv[2]

    machine = os.uname().machine
    architecture = {'x86_64': 'amd64', 'amd64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(machine, machine)
    created = '1970-01-01T00:00:00Z'

    tmp = tempfile.mkdtemp(prefix='vos-image-')
    container = f"vos-export-{uuid.uuid4().hex[:8]}"
    layer_tar = os.path.join(tmp, 'rootfs.tar')
    try:
        run(['docker', 'create', '--name', container, ref])
        # 镜像配置从容器 inspect 读取（受限能力下 image inspect / save 可能被拒绝）。
        info = json.loads(run(['docker', 'container', 'inspect', container]))[0]
        container_config = info.get('Config', {})

        def pick(key):
            value = container_config.get(key)
            return value if value not in (None, [], {}, '') else None

        config = {}
        for key in ('User', 'Env', 'Cmd', 'Entrypoint', 'WorkingDir', 'Labels', 'ExposedPorts',
                    'Volumes', 'StopSignal', 'Healthcheck'):
            value = pick(key)
            if value is not None:
                config[key] = value

        with open(layer_tar, 'wb') as fh:
            proc = subprocess.run(['docker', 'export', container], stdout=fh)
        if proc.returncode != 0:
            raise SystemExit('[ERROR] docker export failed')
        diff_id = sha256_file(layer_tar)

        staged = os.path.join(tmp, 'stage')
        os.makedirs(staged)
        layer_dir = 'layer'
        os.makedirs(os.path.join(staged, layer_dir))
        os.link(layer_tar, os.path.join(staged, layer_dir, 'layer.tar'))
        with open(os.path.join(staged, layer_dir, 'VERSION'), 'w') as fh:
            fh.write('1.0')

        image_config = {
            'architecture': architecture,
            'os': 'linux',
            'created': created,
            'config': config,
            'rootfs': {'type': 'layers', 'diff_ids': [f'sha256:{diff_id}']},
            'history': [{'created': created, 'created_by': 'docker export (vos offline package)'}],
        }
        config_bytes = json.dumps(image_config, separators=(',', ':')).encode()
        config_name = f"{hashlib.sha256(config_bytes).hexdigest()}.json"
        with open(os.path.join(staged, config_name), 'wb') as fh:
            fh.write(config_bytes)

        manifest = [{
            'Config': config_name,
            'RepoTags': [ref],
            'Layers': [f'{layer_dir}/layer.tar'],
        }]
        with open(os.path.join(staged, 'manifest.json'), 'w') as fh:
            json.dump(manifest, fh)

        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        with gzip.open(out_path, 'wb', compresslevel=6) as gz:
            with tarfile.open(fileobj=gz, mode='w') as tar:
                for root, _dirs, files in os.walk(staged):
                    for name in sorted(files):
                        full = os.path.join(root, name)
                        rel = os.path.relpath(full, staged)
                        tar.add(full, arcname=rel, recursive=False)
        print(f"[INFO] wrote {out_path} ({os.path.getsize(out_path)} bytes)")
    finally:
        subprocess.run(['docker', 'rm', '-f', container], capture_output=True, text=True)
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
