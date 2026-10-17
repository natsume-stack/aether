import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';

export const targets = [
    'windows-amd64',
    'windows-arm64',
    'macos-arm64',
    'linux-amd64',
    'linux-arm64',
] as const;
export type PlayerTarget = (typeof targets)[number];
export const MAC_SIGNATURE_REVISION = 1;
export interface ReleaseInfo {
    tag:string;
    version:string;
    commit:string;
    prerelease:boolean;
}
export interface ArtifactManifest {
    formatVersion:1;
    tag:string;
    version:string;
    commit:string;
    target:PlayerTarget;
    file:string;
    size:number;
    sha256:string;
    macSignatureRevision?:number;
}

export function releaseInfo(tag:string, commit:string, packageVersion:string):ReleaseInfo {
    const version = tag.startsWith('player-v') ? tag.slice('player-v'.length) : '';
    const semver =
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
    if (!semver.test(version)) {
        throw new Error('Use a player-v<semver> tag, e.g. player-v0.1.0 or player-v0.2.0-beta.1');
    }
    if (version !== packageVersion) {
        throw new Error(
            `Player tag ${tag} does not match the expected build version ${packageVersion}`,
        );
    }
    if (!/^[a-f0-9]{40}$/.test(commit)) {
        throw new Error('A full release commit SHA is required');
    }
    return { tag, version, commit, prerelease: version.includes('-') };
}

export function playerTarget(value:string):PlayerTarget {
    if (!targets.includes(value as PlayerTarget)) {
        throw new Error(`Unsupported player release target: ${value}`);
    }
    return value as PlayerTarget;
}

export function artifactName(info:ReleaseInfo, target:PlayerTarget):string {
    const extension = target.startsWith('windows-')
        ? 'exe'
        : target.startsWith('linux-')
          ? 'AppImage'
          : 'dmg';
    return `BOX3-Player-Launcher-${info.version}-${target}.${extension}`;
}

export function targetConfiguration(target:PlayerTarget) {
    const architecture = target.endsWith('-amd64') ? 'x64' : 'arm64';
    const platform = target.startsWith('windows-')
        ? 'win32'
        : target.startsWith('linux-')
          ? 'linux'
          : 'darwin';
    const builderFlag = platform === 'win32' ? '--win' : platform === 'linux' ? '--linux' : '--mac';
    const directory =
        platform === 'darwin'
            ? 'mac-arm64'
            : `${platform === 'win32' ? 'win' : 'linux'}${architecture === 'arm64' ? '-arm64' : ''}-unpacked`;
    return { architecture, platform, builderFlag, directory } as const;
}

export function validateManifest(
    value:unknown,
    info:ReleaseInfo,
    target:PlayerTarget,
):ArtifactManifest {
    const record = value as Partial<ArtifactManifest> | null;
    if (
        !record ||
        record.formatVersion !== 1 ||
        record.tag !== info.tag ||
        record.version !== info.version ||
        record.commit !== info.commit ||
        record.target !== target ||
        record.file !== artifactName(info, target) ||
        !Number.isSafeInteger(record.size) ||
        record.size! <= 0 ||
        !/^[a-f0-9]{64}$/.test(record.sha256 || '')
    ) {
        throw new Error(
            `Cached ${target} metadata differs from this tag/commit or is invalid; do not move/reuse release tags`,
        );
    }
    return record as ArtifactManifest;
}

export async function fileDigest(file:string):Promise<{ size:number; sha256:string }> {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size <= 0) {
        throw new Error(`Missing or empty release file: ${file}`);
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) {
        hash.update(chunk);
    }
    return { size: stat.size, sha256: hash.digest('hex') };
}

export async function verifyArtifact(file:string, manifest:ArtifactManifest):Promise<void> {
    const actual = await fileDigest(file);
    if (actual.size !== manifest.size || actual.sha256 !== manifest.sha256) {
        throw new Error(
            `Size/SHA256 mismatch for ${manifest.file}; refusing to publish a corrupted installer`,
        );
    }
}

/** Verify the packaged application binary, not the architecture-neutral NSIS installer stub. */
export function verifyExecutableHeader(header:Buffer, target:PlayerTarget):void {
    if (target.startsWith('windows-')) {
        const offset = header.length >= 64 ? header.readUInt32LE(0x3c) : -1;
        if (
            header.toString('ascii', 0, 2) !== 'MZ' ||
            offset < 0 ||
            offset + 6 > header.length ||
            header.toString('ascii', offset, offset + 4) !== 'PE\0\0' ||
            header.readUInt16LE(offset + 4) !== (target === 'windows-amd64' ? 0x8664 : 0xaa64)
        ) {
            throw new Error(`Packaged executable is not ${target}`);
        }
    } else if (target.startsWith('linux-')) {
        if (
            header.length < 20 ||
            !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
            header[4] !== 2 ||
            header[5] !== 1 ||
            header.readUInt16LE(18) !== (target === 'linux-amd64' ? 0x3e : 0xb7)
        ) {
            throw new Error(`Packaged executable is not ${target}`);
        }
    } else if (
        header.length < 8 ||
        header.readUInt32LE(0) !== 0xfeedfacf ||
        header.readUInt32LE(4) !== 0x0100000c
    ) {
        throw new Error('Packaged executable is not macOS ARM64');
    }
}
