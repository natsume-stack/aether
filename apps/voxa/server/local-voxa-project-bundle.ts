import JSZip from 'jszip';

const BUNDLE_FORMAT = 'box-voxa-project';
const BUNDLE_VERSION = 1;
const RESOURCE_NAMES = new Set([
  'model-meta.bin',
  'model-data.bin',
  'preview.bin',
]);

export type ModelProjectBundleResource = {
  name: 'model-meta.bin' | 'model-data.bin' | 'preview.bin';
  hash: string;
  data: Uint8Array;
  contentType?: string;
};

type BundleInput = {
  projectName: string;
  editType: 0 | 1;
  projectBytes: Uint8Array;
  resources?: ModelProjectBundleResource[];
};

type BundleOutput = BundleInput & {
  resources: ModelProjectBundleResource[];
};

type BundleManifest = {
  format?: string;
  formatVersion?: number;
  projectName?: string;
  editType?: number;
  resources?: Array<{
    name?: string;
    hash?: string;
    contentType?: string;
  }>;
};

function safeProjectName(value: unknown) {
  return String(value || '').trim().slice(0, 100) || '未命名模型';
}

function validResourceName(value: unknown): value is ModelProjectBundleResource['name'] {
  return typeof value === 'string' && RESOURCE_NAMES.has(value);
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

export async function buildModelProjectBundle(input: BundleInput) {
  const zip = new JSZip();
  const resources = input.resources || [];
  zip.file(
    'manifest.json',
    JSON.stringify(
      {
        format: BUNDLE_FORMAT,
        formatVersion: BUNDLE_VERSION,
        exportedAt: new Date().toISOString(),
        projectName: safeProjectName(input.projectName),
        editType: input.editType,
        resources: resources.map(({ name, hash, contentType }) => ({
          name,
          hash,
          contentType: contentType || 'application/octet-stream',
        })),
      },
      null,
      2,
    ),
  );
  zip.file('project.bin', input.projectBytes);
  resources.forEach((resource) => zip.file(resource.name, resource.data));
  return await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

export async function readModelProjectBundle(bundle: Uint8Array): Promise<BundleOutput> {
  const zip = await JSZip.loadAsync(bundle);
  const manifestEntry = zip.file('manifest.json');
  const projectEntry = zip.file('project.bin');
  if (!manifestEntry || !projectEntry) throw new Error('VOXA_BUNDLE_INVALID');
  const manifest = JSON.parse(await manifestEntry.async('string')) as BundleManifest;
  if (
    manifest.format !== BUNDLE_FORMAT ||
    manifest.formatVersion !== BUNDLE_VERSION ||
    (manifest.editType !== 0 && manifest.editType !== 1)
  ) {
    throw new Error('VOXA_BUNDLE_INVALID');
  }

  const seenNames = new Set<string>();
  const resources = await Promise.all(
    (manifest.resources || []).map(async (entry) => {
      const hash = entry?.hash;
      if (
        !validResourceName(entry?.name) ||
        !validHash(hash) ||
        seenNames.has(entry.name)
      ) {
        throw new Error('VOXA_BUNDLE_RESOURCE_INVALID');
      }
      seenNames.add(entry.name);
      const file = zip.file(entry.name);
      if (!file) throw new Error('VOXA_BUNDLE_RESOURCE_INVALID');
      return {
        name: entry.name,
        hash,
        data: await file.async('uint8array'),
        contentType: String(entry.contentType || 'application/octet-stream').slice(0, 100),
      };
    }),
  );
  return {
    projectName: safeProjectName(manifest.projectName),
    editType: manifest.editType,
    projectBytes: await projectEntry.async('uint8array'),
    resources,
  };
}
