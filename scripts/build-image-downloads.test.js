'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { splitArchive, validateCatalog } = require('./build-image-downloads');
const { archiveEntry } = require('./build-desktop-offline-installer');

for (const oci of [false, true]) {
    test(`splitting ${oci ? 'OCI' : 'classic'} archives pins individual images and preserves their content`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-per-service-'));
        try {
            const source = path.join(root, 'source.tar.gz');
            const create = spawnSync(
                process.platform === 'win32' ? 'python' : 'python3',
                [
                    '-c',
                    `
import hashlib,io,json,sys,tarfile
services=['creator','voxa','play','player-service','player-auth-portal','server-manager']
with tarfile.open(sys.argv[1],'w:gz') as archive:
 manifest=[];descriptors=[]
 def add(name,data):
  header=tarfile.TarInfo(name);header.size=len(data);archive.addfile(header,io.BytesIO(data))
 for service in services:
  name=service+'.json'
  config=json.dumps({'os':'linux','architecture':'arm64','config':{'Labels':{'service':service}}}).encode()
  add(name,config)
  if sys.argv[2]=='oci':
   digest=hashlib.sha256(config).hexdigest();config_name='blobs/sha256/'+digest;add(config_name,config)
   data=json.dumps({'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':{'mediaType':'application/vnd.oci.image.config.v1+json','digest':'sha256:'+digest,'size':len(config)},'layers':[]}).encode()
   manifest_digest=hashlib.sha256(data).hexdigest();add('blobs/sha256/'+manifest_digest,data)
   descriptors.append({'mediaType':'application/vnd.oci.image.manifest.v1+json','digest':'sha256:'+manifest_digest,'size':len(data),'annotations':{'io.containerd.image.name':'docker.io/library/box-local-engine-'+service+':original'}})
   name=config_name
  manifest.append({'Config':name,'RepoTags':['box-local-engine-'+service+':original'],'Layers':[]})
 add('manifest.json',json.dumps(manifest).encode())
 if descriptors:
  add('index.json',json.dumps({'schemaVersion':2,'manifests':descriptors}).encode())
  add('oci-layout',b'{"imageLayoutVersion":"1.0.0"}')
`,
                    source,
                    oci ? 'oci' : 'classic',
                ],
                { encoding: 'utf8' },
            );
            assert.equal(create.status, 0, create.stderr);
            const catalog = splitArchive(source, 'arm64', path.join(root, 'first/catalog.json'));
            const repeated = splitArchive(source, 'arm64', path.join(root, 'second/catalog.json'));
            assert.equal(catalog.images.length, 6);
            const partialPath = path.join(root, 'manager-only/catalog.json');
            const partial = spawnSync(
                process.platform === 'win32' ? 'python' : 'python3',
                [
                    path.join(__dirname, 'split-image-archive.py'),
                    source,
                    'arm64',
                    partialPath,
                    require('../package.json').version,
                    'server-manager',
                ],
                { encoding: 'utf8' },
            );
            assert.equal(partial.status, 0, partial.stderr);
            const managerOnly = JSON.parse(fs.readFileSync(partialPath, 'utf8'));
            assert.equal(managerOnly.images.length, 1);
            assert.deepEqual(
                managerOnly.images[0],
                catalog.images.find((image) => image.image === 'box-local-engine-server-manager'),
            );
            for (const image of catalog.images) {
                const archive = path.join(root, 'first', image.archive);
                assert.equal(
                    crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
                    image.sha256,
                );
                const entry = JSON.parse(archiveEntry(archive, 'manifest.json'))[0];
                assert.deepEqual(entry.RepoTags, [
                    `${image.image}:launcher-content-${image.imageId.slice(7)}`,
                ]);
                assert.ok(
                    image.imageIds.includes(
                        `sha256:${crypto.createHash('sha256').update(archiveEntry(archive, entry.Config)).digest('hex')}`,
                    ),
                );
                if (oci) {
                    assert.equal(
                        JSON.parse(archiveEntry(archive, 'index.json')).manifests[0].digest,
                        image.imageId,
                    );
                }
                assert.equal(
                    repeated.images.find((i) => i.image === image.image).sha256,
                    image.sha256,
                );
            }
            const invalid = structuredClone(catalog);
            invalid.images[0].archive = '../outside.tar.gz';
            assert.throws(() => validateCatalog(invalid, 'arm64'), /Invalid image download/);
            assert.throws(() => validateCatalog(catalog, 'amd64'), /Invalid per-service/);
            invalid.images = [catalog.images[0], ...catalog.images.slice(0, 5)];
            assert.throws(() => validateCatalog(invalid, 'arm64'), /Missing or duplicate/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}
