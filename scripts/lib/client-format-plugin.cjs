'use strict';

const path = require('node:path');
const roots = [path.resolve(__dirname, '../../tools/repo-tooling')];
const estree = require(require.resolve('prettier/plugins/estree', { paths: roots }));
const typescript = require(require.resolve('prettier/plugins/typescript', { paths: roots }));
const babel = require(require.resolve('prettier/plugins/babel', { paths: roots }));
const ts = require(
    require.resolve('typescript', {
        paths: [path.resolve(__dirname, '../../apps/player-launcher')],
    }),
);

/** Add blocks using syntax nodes so strings, comments and JSX remain untouched. */
function addControlBlocks(source, options) {
    const kind = options.filepath?.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    source = groupImports(source, kind);
    const file = ts.createSourceFile(
        options.filepath || 'source.ts',
        source,
        ts.ScriptTarget.Latest,
        true,
        kind,
    );
    const edits = [];
    const wrap = (statement) => {
        if (!statement || ts.isBlock(statement)) {
            return;
        }
        edits.push(
            { position: statement.getStart(file), text: '{' },
            { position: statement.end, text: '}' },
        );
    };
    const visit = (node) => {
        if (ts.isIfStatement(node)) {
            wrap(node.thenStatement);
            if (node.elseStatement && !ts.isIfStatement(node.elseStatement)) {
                wrap(node.elseStatement);
            }
        } else if (
            ts.isForStatement(node) ||
            ts.isForOfStatement(node) ||
            ts.isForInStatement(node) ||
            ts.isWhileStatement(node) ||
            ts.isDoStatement(node)
        ) {
            wrap(node.statement);
        }
        if (
            options.parser === 'typescript' &&
            (ts.isClassDeclaration(node) || ts.isClassExpression(node))
        ) {
            for (const member of node.members) {
                const visible = ts
                    .getModifiers(member)
                    ?.some((modifier) =>
                        [
                            ts.SyntaxKind.PublicKeyword,
                            ts.SyntaxKind.ProtectedKeyword,
                            ts.SyntaxKind.PrivateKeyword,
                        ].includes(modifier.kind),
                    );
                const supported =
                    ts.isMethodDeclaration(member) ||
                    ts.isPropertyDeclaration(member) ||
                    ts.isConstructorDeclaration(member) ||
                    ts.isGetAccessorDeclaration(member) ||
                    ts.isSetAccessorDeclaration(member);
                if (
                    supported &&
                    !visible &&
                    !ts.isPrivateIdentifier(member.name || {}) &&
                    !ts.getDecorators(member)?.length
                ) {
                    edits.push({ position: member.getStart(file), text: 'public ' });
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    for (const edit of edits.sort((left, right) => right.position - left.position)) {
        source = source.slice(0, edit.position) + edit.text + source.slice(edit.position);
    }
    return source;
}

/** Keep side-effect import order; ordinary import order stays stable within each group. */
function groupImports(source, kind) {
    const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, kind);
    const imports = [];
    for (const statement of file.statements) {
        if (!ts.isImportDeclaration(statement)) {
            break;
        }
        imports.push(statement);
    }
    if (!imports.length || imports.some((node) => !node.importClause)) {
        return source;
    }
    const groups = [[], [], []];
    imports.forEach((node, index) => {
        const relative = node.moduleSpecifier.text.startsWith('.');
        const group = node.importClause.isTypeOnly ? 2 : relative ? 1 : 0;
        groups[group].push(
            source.slice(index ? node.getFullStart() : node.getStart(file), node.end).trim(),
        );
    });
    return (
        source.slice(0, imports[0].getStart(file)) +
        groups
            .filter((group) => group.length)
            .map((group) => group.join('\n'))
            .join('\n\n') +
        source.slice(imports.at(-1).end)
    );
}

function parser(original) {
    return { ...original, astFormat: 'box-client-estree', preprocess: addControlBlocks };
}

module.exports = {
    parsers: {
        typescript: parser(typescript.parsers.typescript),
        babel: parser(babel.parsers.babel),
    },
    printers: {
        'box-client-estree': {
            ...estree.printers.estree,
            print(...args) {
                const doc = estree.printers.estree.print(...args);
                if (
                    args[0].node.type === 'TSTypeAnnotation' &&
                    Array.isArray(doc) &&
                    doc[0] === ':' &&
                    doc[1] === ' '
                ) {
                    return [doc[0], ...doc.slice(2)];
                }
                return doc;
            },
        },
    },
};
