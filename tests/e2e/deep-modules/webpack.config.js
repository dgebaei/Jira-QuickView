/* eslint-env node */
const path = require('path');

const repoRoot = path.resolve(__dirname, '../../..');

module.exports = {
  devtool: 'source-map',
  entry: path.join(__dirname, 'harness-entry.js'),
  output: {
    path: path.join(repoRoot, 'tests/output/playwright/deep-modules'),
    filename: 'harness.js',
    pathinfo: true,
  },
  module: {
    rules: [{
      test: /\.(js|jsx)$/,
      exclude: /node_modules/,
      use: [{
        loader: 'babel-loader',
        options: {
          presets: [[
            '@babel/preset-env',
            {
              targets: {chrome: 73},
              modules: false,
              loose: true,
              useBuiltIns: false,
            },
          ]],
        },
      }],
    }],
  },
  resolve: {
    modules: [
      path.join(repoRoot, 'node_modules'),
      path.join(repoRoot, 'jira-plugin'),
    ],
    extensions: ['.js', '.jsx'],
  },
};
