module.exports = {
    parser: '@typescript-eslint/parser',
    parserOptions: {
      project: 'tsconfig.json',
      sourceType: 'module',
    },
    //plugins: ['@typescript-eslint/eslint-plugin'],
    extends: [
      'airbnb-base',
      'airbnb-typescript/base',
      'plugin:prettier/recommended',
      // 'plugin:@typescript-eslint/recommended-requiring-type-checking',
    ],
    root: true,
    env: {
      node: true,
      jest: true,
    },
    ignorePatterns: ['.eslintrc.js', 'ecosystem.config.js'],
    settings: {
      'import/resolver': {
        typescript: {},
      },
    },
    rules: {
      'no-void': ['error', { allowAsStatement: true }],
      'import/order': 'error',
      'class-methods-use-this': 'warn',
      'no-plusplus': 'off',
      'no-continue': 'off',
      'max-line': '150',
      'no-restricted-syntax': 'off',
      'class-methods-use-this': 'off',
      'max-classes-per-file': 'off',
      '@typescript-eslint/return-await': ['error', 'always'],
      yoda: ['error', 'never', { exceptRange: true }],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: false },
      ],
    },
    overrides: [
      {
        files: ['src/services/WebServer/routes/**/*.ts'],
        rules: {
          '@typescript-eslint/no-misused-promises': [
            'error',
            { checksVoidReturn: false },
          ], // disable for express router
        },
      },
    ],
  };
  