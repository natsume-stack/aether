import JSZip from 'jszip';
import {
  migrateProject,
  projectSchemaToBytes,
} from '@box/voxa-project';

import { EditType } from '../../redux/app-slice';
import { ProjectDataSchema } from '../project/defs';
import type { ProjectData } from '../project/interfaces';

const BUNDLE_FORMAT = 'box-voxa-project';
const BUNDLE_VERSION = 1;
const MAX_PROJECT_FILE_SIZE = 256 * 1024 * 1024;

type ProjectManifest = {
  format: typeof BUNDLE_FORMAT;
  formatVersion: typeof BUNDLE_VERSION;
  exportedAt: string;
  projectName: string;
  editType: EditType;
};

export type ImportedProjectBundle = {
  projectData: ProjectData;
  projectName: string;
  editType: EditType;
};

function safeProjectName(value: string) {
  return value.trim().slice(0, 100) || '未命名模型';
}

export function getProjectBundleFileName(projectName: string) {
  const safeName = safeProjectName(projectName)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.+$/g, '')
    .trim();
  return `${safeName || '未命名模型'}.voxaproject`;
}

export async function createProjectBundle(params: {
  projectData: ProjectData;
  projectName: string;
  editType: EditType;
}) {
  const manifest: ProjectManifest = {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    projectName: safeProjectName(params.projectName),
    editType: params.editType,
  };
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('project.bin', projectSchemaToBytes(params.projectData));
  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    mimeType: 'application/vnd.box.voxaproject+zip',
  });
}

export async function readProjectBundle(file: File): Promise<ImportedProjectBundle> {
  if (file.size <= 0 || file.size > MAX_PROJECT_FILE_SIZE) {
    throw new Error('INVALID_PROJECT_FILE_SIZE');
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new Error('INVALID_PROJECT_BUNDLE');
  }

  const manifestEntry = zip.file('manifest.json');
  const projectEntry = zip.file('project.bin');
  if (!manifestEntry || !projectEntry) {
    throw new Error('INVALID_PROJECT_BUNDLE');
  }

  let manifest: ProjectManifest;
  try {
    manifest = JSON.parse(await manifestEntry.async('string'));
  } catch {
    throw new Error('INVALID_PROJECT_BUNDLE');
  }

  if (
    manifest.format !== BUNDLE_FORMAT ||
    manifest.formatVersion !== BUNDLE_VERSION ||
    !Object.values(EditType).includes(manifest.editType)
  ) {
    throw new Error('UNSUPPORTED_PROJECT_BUNDLE');
  }

  const bytes = await projectEntry.async('uint8array');
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_PROJECT_FILE_SIZE) {
    throw new Error('INVALID_PROJECT_FILE_SIZE');
  }
  const projectData = migrateProject(bytes);
  if (!projectData) {
    throw new Error('INVALID_PROJECT_DATA');
  }

  try {
    ProjectDataSchema.equal(
      ProjectDataSchema.identity,
      projectData as ProjectData,
    );
  } catch {
    throw new Error('INVALID_PROJECT_DATA');
  }

  return {
    projectData: projectData as ProjectData,
    projectName: safeProjectName(manifest.projectName),
    editType: manifest.editType,
  };
}
