export function installerTarget(info) {
    const architecture = { x86_64: 'amd64', aarch64: 'arm64' }[info.architecture];
    const target = `${info.platform}-${architecture}`;
    if (
        !['windows-amd64', 'windows-arm64', 'macos-arm64', 'linux-amd64', 'linux-arm64'].includes(
            target,
        )
    ) {
        throw new Error('当前系统暂无对应安装包');
    }
    return target;
}

export function parseVersion(value) {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-staging)?(?:\+[\w.-]+)?$/.exec(
        String(value),
    );
    if (!match) {
        throw new Error('版本信息格式无效');
    }
    return match.slice(1).map(Number);
}

export function releaseBase(version) {
    if (/(?:-|\.)dev$/.test(String(version))) {
        throw new Error('开发版不使用线上更新渠道');
    }
    return `https://assets.box3.fun/local-engine${
        String(version)
            .replace(/\+[\w.-]+$/, '')
            .endsWith('-staging')
            ? '-staging'
            : ''
    }`;
}

export function isNewerVersion(latest, current) {
    if (releaseBase(latest) !== releaseBase(current)) {
        throw new Error('更新清单渠道与当前启动器不一致');
    }
    const a = parseVersion(latest),
        b = parseVersion(current);
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) {
            return a[i] > b[i];
        }
    }
    return false;
}

export function validateRelease(value) {
    if (value?.schemaVersion !== 1) {
        throw new Error('更新清单格式无效');
    }
    parseVersion(value.version);
    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
        !Number.isFinite(Date.parse(value.date)) ||
        new Date(value.date).toISOString().slice(0, 10) !== value.date
    ) {
        throw new Error('更新日期无效');
    }
    if (
        typeof value.summary !== 'string' ||
        !Array.isArray(value.sections) ||
        value.sections.length > 30
    ) {
        throw new Error('更新日志无效');
    }
    for (const section of value.sections) {
        if (
            typeof section.title !== 'string' ||
            !Array.isArray(section.items) ||
            section.items.length > 100 ||
            section.items.some((item) => typeof item !== 'string')
        ) {
            throw new Error('更新日志无效');
        }
    }
    return value;
}
