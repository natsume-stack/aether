'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const markdown = require(
    require.resolve('prettier/plugins/markdown', {
        paths: [path.resolve(__dirname, '../../tools/repo-tooling')],
    }),
);

function markdownFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            return [
                'node_modules',
                'build',
                'dist',
                'dist-electron',
                'release-electron',
                'rush-logs',
                'target',
                '.git',
                '.umi',
                '.umi-production',
                'data',
                'projects',
                'play-worlds',
                'backups',
                'runtime-cache',
            ].includes(entry.name)
                ? []
                : markdownFiles(target);
        }
        return entry.isFile() && entry.name.endsWith('.md') ? [target] : [];
    });
}

/** Include maintained and embedded documentation, excluding ignored build/runtime files. */
function repositoryMarkdownFiles(root) {
    return [
        ...new Set(
            execFileSync(
                'git',
                ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md'],
                { cwd: root, encoding: 'utf8' },
            )
                .split('\0')
                .filter(Boolean),
        ),
    ]
        .map((file) => path.join(root, file))
        .filter((file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
}

function headingText(node) {
    if (node.type === 'text' || node.type === 'inlineCode') {
        return node.value;
    }
    if (node.type === 'image' || node.type === 'imageReference') {
        return node.alt || '';
    }
    return (node.children || []).map(headingText).join('');
}

function documentAnchors(ast) {
    const anchors = new Set();
    const generated = new Set();
    const visit = (node) => {
        if (node.type === 'heading') {
            const base = headingText(node)
                .toLowerCase()
                .replace(/[\p{Punctuation}\p{Symbol}\p{Control}]/gu, (character) =>
                    ['-', '_'].includes(character) ? character : '',
                )
                .replace(/ /g, '-');
            let slug = base;
            for (let suffix = 1; generated.has(slug); suffix += 1) {
                slug = `${base}-${suffix}`;
            }
            generated.add(slug);
            anchors.add(slug);
        }
        if (node.type === 'html') {
            const html = node.value.replace(/<!--[\s\S]*?-->/g, '');
            for (const tag of html.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)) {
                for (const attribute of tag[0].matchAll(
                    /\s(id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
                )) {
                    if (attribute[1].toLowerCase() === 'id' || tag[1].toLowerCase() === 'a') {
                        anchors.add(attribute[2] ?? attribute[3] ?? attribute[4]);
                    }
                }
            }
        }
        node.children?.forEach(visit);
    };
    visit(ast);
    return anchors;
}

/** Parse Markdown links rather than treating code examples or URL parentheses as markup. */
async function assertLocalLinks(files, root) {
    const documents = new Map();
    const read = async (file) => {
        if (!documents.has(file)) {
            documents.set(
                file,
                await markdown.parsers.markdown.parse(fs.readFileSync(file, 'utf8')),
            );
        }
        return documents.get(file);
    };
    for (const file of files) {
        const ast = await read(file);
        const definitions = new Map();
        const links = [];
        const references = [];
        const visit = (node) => {
            if (node.type === 'definition') {
                definitions.set(node.identifier.toLowerCase(), node.url);
            } else if (node.type === 'link' || node.type === 'image') {
                links.push(node.url);
            } else if (node.type === 'linkReference' || node.type === 'imageReference') {
                references.push(node.identifier.toLowerCase());
            } else if (node.type === 'html') {
                const html = node.value.replace(/<!--[\s\S]*?-->/g, '');
                for (const tag of html.matchAll(/<[a-z][\w:-]*\b[^>]*>/gi)) {
                    for (const attribute of tag[0].matchAll(
                        /\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
                    )) {
                        links.push(attribute[1] ?? attribute[2] ?? attribute[3]);
                    }
                }
            }
            node.children?.forEach(visit);
        };
        visit(ast);
        for (const reference of references) {
            // Unresolved shortcut references are plain text in Markdown, not links.
            if (definitions.has(reference)) {
                links.push(definitions.get(reference));
            }
        }
        for (const reference of links) {
            if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) {
                continue;
            }
            const fragmentStart = reference.indexOf('#');
            const target = (
                fragmentStart < 0 ? reference : reference.slice(0, fragmentStart)
            ).split('?', 1)[0];
            const destination = target
                ? path.resolve(path.dirname(file), decodeURIComponent(target))
                : file;
            assert.ok(
                fs.statSync(destination, { throwIfNoEntry: false }),
                `${path.relative(root, file)} links to missing ${target}`,
            );
            if (
                fragmentStart >= 0 &&
                reference.slice(fragmentStart + 1) &&
                /\.md$/i.test(destination)
            ) {
                const fragment = decodeURIComponent(reference.slice(fragmentStart + 1));
                assert.ok(
                    documentAnchors(await read(destination)).has(fragment),
                    `${path.relative(root, file)} links to missing anchor ${reference}`,
                );
            }
        }
    }
}

module.exports = { markdownFiles, repositoryMarkdownFiles, assertLocalLinks };
