#!/usr/bin/env python3
"""Resolve app dependencies from the live published catalog into staged YAML."""
import argparse
import json
import os
import re
import sys
import urllib.request
import urllib.parse

import yaml


def appstore_version(app_id: str, base: str) -> str:
    """私有 GitHub 仓库改从已授权隧道读取实时发布记录，不扩大 CI 令牌权限。"""
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.path not in {"", "/"}:
        raise RuntimeError("App Store dependency verification requires the approved loopback tunnel")
    with urllib.request.urlopen(f"{base.rstrip('/')}/api/appstore/apps/{app_id}", timeout=30) as response:
        record = json.load(response)
    detail = record.get("data") or {}
    version = detail.get("current_version", "")
    versions = [v for v in detail.get("versions", []) if re.fullmatch(r"\d+\.\d+\.\d+", v)]
    archive = detail.get("app_tar_gz") or {}
    expected = f"appstore/apps/{app_id}/{version}/app.tar.gz"
    if (record.get("code") != 0 or detail.get("id") != app_id or not versions
            or version != max(versions, key=lambda v: tuple(map(int, v.split("."))))
            or archive.get("size", 0) <= 0 or archive.get("download_path") != expected):
        raise RuntimeError(f"{app_id}: no verified latest published App Store package")
    probe = urllib.request.Request(f"{base.rstrip('/')}/store/{expected}",
                                   headers={"Range": "bytes=0-1", "Accept-Encoding": "identity"})
    with urllib.request.urlopen(probe, timeout=30) as response:
        prefix = response.read(2)
        valid = prefix == b"\x1f\x8b"
        if response.status == 206:
            valid = valid and response.headers.get("Content-Range") == f"bytes 0-1/{archive['size']}"
        elif response.status == 200:
            count = len(prefix)
            while count <= archive["size"]:
                chunk = response.read(min(1024 * 1024, archive["size"] + 1 - count))
                if not chunk:
                    break
                count += len(chunk)
            valid = valid and count == archive["size"]
        else:
            valid = False
        if not valid:
            raise RuntimeError(f"{app_id}: published App Store archive is unavailable or changed")
    return version


def resolve_dependencies(manifest, repositories, api_url="https://api.github.com"):
    dependencies = (manifest.get('dependencies') or {}).get('apps', [])
    if not dependencies:
        return []
    headers = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
    token = os.environ.get('VOS_DEPENDENCY_RELEASE_TOKEN') or os.environ.get('GH_TOKEN')
    if token:
        headers['Authorization'] = 'Bearer ' + token
    catalog_url = os.environ.get('VOS_DEPENDENCY_CATALOG_URL')
    resolved = []
    for dependency in dependencies:
        app_id = dependency['id']
        repository = repositories.get(app_id)
        if not repository:
            raise ValueError(f'{app_id}: dependency release repository is not configured')
        if catalog_url:
            actual = appstore_version(app_id, catalog_url)
        else:
            request = urllib.request.Request(api_url.rstrip('/') + '/repos/' + repository + '/releases/latest', headers=headers)
            with urllib.request.urlopen(request, timeout=30) as response:
                release = json.load(response)
            tag = release.get('tag_name', '')
            match = re.fullmatch(r'v?(\d+\.\d+\.\d+)', tag)
            if not match or release.get('draft') or release.get('prerelease') or not release.get('published_at'):
                raise ValueError(f'{app_id}: no supported published Release version')
            actual = match.group(1)
            if not any(asset.get('name', '').endswith('_pull.tar') for asset in release.get('assets', [])):
                raise ValueError(f'{app_id}: published Release has no VOS pull package')
        # Only a real published Release determines the package requirement.
        dependency['version'] = '>=' + actual
        resolved.append({'id': app_id, 'published': actual, 'requirement': dependency['version']})
    return resolved


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', help='staged manifest.yml (source template remains unchanged)')
    parser.add_argument('--repositories', required=True)
    parser.add_argument('--api-url', default='https://api.github.com')
    args = parser.parse_args()
    try:
        with open(args.manifest, encoding='utf-8') as source:
            manifest = yaml.safe_load(source)
        with open(args.repositories, encoding='utf-8') as source:
            repositories = json.load(source)
        resolved = resolve_dependencies(manifest, repositories, args.api_url)
        with open(args.manifest, 'w', encoding='utf-8') as target:
            yaml.safe_dump(manifest, target, allow_unicode=True, sort_keys=False)
    except (ValueError, KeyError, OSError, yaml.YAMLError) as error:
        print(f'Dependency resolution failed: {error}', file=sys.stderr)
        return 1
    for dependency in resolved:
        print(f"Dependency resolved: {dependency['id']} published={dependency['published']} package={dependency['requirement']}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
