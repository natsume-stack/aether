module.exports = {
    root: true,
    env: {
        es2022: true,
        node: true,
    },
    extends: ['eslint:recommended', 'prettier'],
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'script',
    },
    rules: {
        'no-console': 'off',
        'no-constant-condition': ['error', { checkLoops: false }],
        // File-name sanitizers intentionally match ASCII control characters.
        'no-control-regex': 'off',
        'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
    overrides: [
        {
            files: ['apps/server-manager/public/**/*.js'],
            env: {
                browser: true,
                node: false,
            },
        },
        {
            // Contains an embedded compatibility bootstrap script. Escapes are part
            // of the generated source text rather than the surrounding JavaScript.
            files: ['apps/local-engine/src/project-manager.js'],
            rules: {
                'no-useless-escape': 'off',
            },
        },
    ],
};
