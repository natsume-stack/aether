"""Split a Docker save archive without loading or retagging local Docker images."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile

SERVICES = ['creator', 'voxa', 'play', 'player-service', 'player-auth-portal', 'server-manager']


def split_archive(source, architecture, destination, version, selected_services=None):
    services = selected_services.split(',') if selected_services else SERVICES
    if not services or len(set(services)) != len(services) or any(service not in SERVICES for service in services):
        raise ValueError('Invalid service selection')
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    entries = []
    with tarfile.open(source, 'r:gz') as archive:
        manifests = json.load(archive.extractfile('manifest.json'))
        index = json.load(archive.extractfile('index.json')) if 'index.json' in archive.getnames() else None
        for service in services:
            image = 'box-local-engine-' + service
            matches = [entry for entry in manifests if any(tag.startswith(image + ':') for tag in entry.get('RepoTags', []))]
            if len(matches) != 1:
                raise ValueError('Missing or duplicate image: ' + service)
            entry = matches[0]
            contents = archive.extractfile(entry['Config']).read()
            config = json.loads(contents)
            if config.get('os') != 'linux' or config.get('architecture') != architecture:
                raise ValueError('Source image architecture mismatch: ' + service)
            digest = hashlib.sha256(contents).hexdigest()
            name = f'box-local-engine-image-{service}-{architecture}-{digest}.tar.gz'
            labels = config.get('config', {}).get('Labels') or {}
            tag = next(tag[len(image) + 1:] for tag in entry['RepoTags'] if tag.startswith(image + ':'))
            descriptor = None
            blobs = set()
            if index:
                descriptor = next((item for item in index['manifests'] if any(
                    reference.endswith(image + ':' + tag) for reference in item.get('annotations', {}).values())), None)
                if descriptor is None:
                    raise ValueError('OCI image descriptor not found: ' + service)
                def visit(item):
                    blob = 'blobs/sha256/' + item['digest'].removeprefix('sha256:')
                    if blob in blobs:
                        return
                    blobs.add(blob)
                    if 'index' in item.get('mediaType', '') or 'manifest' in item.get('mediaType', ''):
                        contents = archive.extractfile(blob).read()
                        if hashlib.sha256(contents).hexdigest() != item['digest'].removeprefix('sha256:'):
                            raise ValueError('OCI descriptor digest mismatch')
                        data = json.loads(contents)
                        for child in data.get('manifests', []):
                            visit(child)
                        if 'config' in data:
                            visit(data['config'])
                        for child in data.get('layers', []):
                            visit(child)
                visit(descriptor)
            image_id = descriptor['digest'] if descriptor else 'sha256:' + digest
            entry['_oci_descriptor'] = descriptor
            entry['_oci_blobs'] = list(blobs)
            entries.append((entry, {
                'formatVersion': 1, 'image': image, 'imageId': image_id, 'imageIds': list(dict.fromkeys([image_id, 'sha256:' + digest])),
                'imageTag': tag, 'tag': tag, 'archive': name, 'platform': 'linux/' + architecture,
                'createdAt': config.get('created', 'unknown'),
                'sourceRevision': labels.get('org.opencontainers.image.revision', 'unknown'),
                'buildSource': labels.get('org.opencontainers.image.source', 'unknown'),
            }))
    outputs = []
    wanted = {}
    try:
        for index, (entry, info) in enumerate(entries):
            partial = destination.parent / (info['archive'] + '.part')
            raw = partial.open('wb')
            compressed = gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0, compresslevel=1)
            output = tarfile.open(fileobj=compressed, mode='w|')
            outputs.append((output, partial, compressed, raw))
            content_tag = 'launcher-content-' + info['imageId'].removeprefix('sha256:')
            reference = info['image'] + ':' + content_tag
            manifest = {key: value for key, value in entry.items() if not key.startswith('_oci_')}
            manifest['RepoTags'] = [reference]
            def add_json(name, value):
                contents = json.dumps(value, separators=(',', ':')).encode()
                header = tarfile.TarInfo(name)
                header.size = len(contents)
                output.addfile(header, io.BytesIO(contents))
            add_json('manifest.json', [manifest])
            if entry['_oci_descriptor']:
                descriptor = dict(entry['_oci_descriptor'])
                descriptor['annotations'] = {'io.containerd.image.name': 'docker.io/library/' + reference,
                                             'org.opencontainers.image.ref.name': content_tag}
                add_json('oci-layout', {'imageLayoutVersion': '1.0.0'})
                add_json('index.json', {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json',
                                       'manifests': [descriptor]})
            for name in set([entry['Config'], *entry['Layers'], *entry['_oci_blobs']]):
                if name.startswith('/') or '..' in Path(name).parts:
                    raise ValueError('Invalid archive member path')
                wanted.setdefault(name, set()).add(index)
        with tarfile.open(source, 'r|gz') as archive:
            for member in archive:
                targets = wanted.pop(member.name, None)
                if not targets:
                    continue
                if not member.isfile():
                    raise ValueError('Image archive member must be a regular file')
                with tempfile.SpooledTemporaryFile(max_size=4 * 1024 * 1024) as data:
                    stream = archive.extractfile(member)
                    while chunk := stream.read(1024 * 1024):
                        data.write(chunk)
                    for index in targets:
                        data.seek(0)
                        outputs[index][0].addfile(member, data)
        if wanted:
            raise ValueError('Image archive is missing referenced layers or configs')
        for (output, partial, compressed, raw), (_, info) in zip(outputs, entries):
            output.close()
            compressed.close()
            raw.close()
            digest = hashlib.sha256()
            with partial.open('rb') as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
            info['sha256'] = digest.hexdigest()
            info['size'] = partial.stat().st_size
            service = info['image'].removeprefix('box-local-engine-')
            info['archive'] = f"box-local-engine-image-{service}-{architecture}-{info['sha256']}.tar.gz"
            partial.replace(destination.parent / info['archive'])
        source_digest = hashlib.sha256()
        with open(source, 'rb') as stream:
            while chunk := stream.read(1024 * 1024):
                source_digest.update(chunk)
        catalog = {'sourceArchiveSha256': source_digest.hexdigest(), 'formatVersion': 2, 'imageTag': f'v{version}-linux-{architecture}',
                   'platform': 'linux/' + architecture, 'images': [info for _, info in entries]}
        temporary = destination.with_suffix('.json.part')
        temporary.write_text(json.dumps(catalog, indent=2) + '\n')
        temporary.replace(destination)
    finally:
        for output, partial, compressed, raw in outputs:
            output.close()
            compressed.close()
            raw.close()
            partial.unlink(missing_ok=True)


if __name__ == '__main__':
    split_archive(*sys.argv[1:])
