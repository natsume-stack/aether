module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['next/core-web-vitals', 'prettier'],
  rules: {
    // Assets are served by the local content server; next/image would add an
    // unrelated cache layer and does not understand content-addressed URLs.
    '@next/next/no-img-element': 'off',
    // The inherited engine still contains these patterns. Keep them visible
    // while allowing the local repository to adopt lint as a gradual gate.
    '@next/next/no-html-link-for-pages': 'warn',
    '@next/next/no-assign-module-variable': 'warn',
    'react/display-name': 'warn',
    'react/no-children-prop': 'warn',
    'react/no-deprecated': 'warn',
    'react-hooks/rules-of-hooks': 'warn',
  },
}
