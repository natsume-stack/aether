const ownedCode = require('./scripts/lib/owned-code-config.cjs');

module.exports = {
    printWidth: 100,
    semi: false,
    singleQuote: true,
    quoteProps: 'consistent',
    trailingComma: 'all',
    endOfLine: 'lf',
    proseWrap: 'preserve',
    overrides: [
        {
            files: ownedCode.patterns,
            options: ownedCode.options,
        },
    ],
};
