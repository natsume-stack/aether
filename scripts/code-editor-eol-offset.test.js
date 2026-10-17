const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
    path.resolve(__dirname, '../apps/game/src/client/edit/code-editor/monaco.ts'),
    'utf8',
);

test('Monaco preserves imported CRLF offsets used by collaborative text', () => {
    const importedText = 'first\r\nsecond\r\nthird';
    const intendedOffset = importedText.indexOf('third');
    const forcedLfText = importedText.replace(/\r\n/g, '\n');

    assert.notEqual(
        forcedLfText.indexOf('third'),
        intendedOffset,
        'fixture must demonstrate the offset drift caused by forced LF',
    );
    assert.doesNotMatch(
        source,
        /\.setEOL\(0\)/,
        'forcing LF makes Monaco offsets diverge from imported CRLF scripts',
    );
});
