'use strict';

const fs = require('node:fs');
const path = require('node:path');

function frontendFiles(root, extension) {
    const directory = path.join(root, 'apps/deployment-manager/src');
    return fs
        .readdirSync(directory, { recursive: true })
        .filter((file) => file.endsWith(extension))
        .sort()
        .map((file) => path.join(directory, file));
}

function frontendSource(root, extension = '.js') {
    return frontendFiles(root, extension)
        .map((file) => fs.readFileSync(file, 'utf8'))
        .join('\n');
}

/** Locate a selector's forEach callback without depending on indentation or semicolons. */
function querySelectorCallback(source, selector) {
    const ts = require(
        require.resolve('typescript', {
            paths: [
                path.join(__dirname, '../../apps/player-launcher'),
                path.join(__dirname, '../../internals/apis'),
            ],
        }),
    );
    const file = ts.createSourceFile(
        'frontend.js',
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    );
    let result;
    const visit = (node) => {
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'forEach'
        ) {
            const query = node.expression.expression;
            if (
                ts.isCallExpression(query) &&
                ts.isPropertyAccessExpression(query.expression) &&
                query.expression.name.text === 'querySelectorAll' &&
                query.arguments[0]?.text === selector
            ) {
                result = node.arguments[0]?.getText(file);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return result;
}

module.exports = { frontendFiles, frontendSource, querySelectorCallback };
