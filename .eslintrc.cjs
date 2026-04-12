module.exports = {
  root: true,
  env: {
    browser: true,
    commonjs: true,
    es2021: true,
    node: true,
  },
  extends: 'eslint:recommended',
  plugins: [
    'react',
  ],
  globals: {
    chrome: 'readonly',
  },
  ignorePatterns: [
    '.idea/',
    '.tools/',
    '.worktrees/',
    'jira-plugin/build/',
    'jira-plugin/options/build/',
    'node_modules/',
    'tests/output/',
  ],
  parserOptions: {
    ecmaFeatures: {
      jsx: true,
    },
    sourceType: 'module',
  },
  rules: {
    'react/jsx-uses-vars': 'warn',
    'no-console': 'off',
    'no-redeclare': 'off',
    'no-undef': 'off',
    'no-unused-vars': 'off',
    'no-useless-escape': 'warn',
    'prefer-const': 'warn',
    'indent': 'off',
    'linebreak-style': 'off',
    'quotes': 'off',
    'semi': 'off',
  },
};
