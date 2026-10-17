/**
 * Next本身处理了TS相关的Parser逻辑，除非你知道Next做了什么，
 * 否则不要修改除了rule之外的任何其他字段。
 */
module.exports = {
  root: true,
  extends: ['next/core-web-vitals', 'plugin:sonarjs/recommended', 'prettier'],
  rules: {
    'react/no-array-index-key': 'warn',
    '@typescript-eslint/explicit-member-accessibility': [
      'error',
      {
        accessibility: 'explicit',
        overrides: {
          constructors: 'no-public',
        },
      },
    ],
    '@typescript-eslint/type-annotation-spacing': 'off',
    'space-before-function-paren': [
      'error',
      {
        anonymous: 'always',
        named: 'never',
        asyncArrow: 'always',
      },
    ],

    // Sonar rules
    'sonarjs/no-small-switch': 'warn',
    'sonarjs/cognitive-complexity': ['warn', 15],
    'sonarjs/no-collapsible-if': 'warn',
    'sonarjs/no-duplicated-branches': 'warn',
    'sonarjs/no-nested-switch': 'warn',
    'sonarjs/no-identical-functions': 'warn',
    'sonarjs/prefer-immediate-return': 'warn',
    'sonarjs/no-duplicate-string': 'warn',
    'sonarjs/no-redundant-boolean': 'warn',
    /**
     * next/image虽然会压缩图片。
     * 但也需要把压缩后的图片缓存到服务器中，占用存储。
     * 而我们已经在用cdn了。
     */
    '@next/next/no-img-element': 'off',
  },
  plugins: ['@typescript-eslint', 'sonarjs'],
};
