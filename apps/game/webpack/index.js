const { dirname, join } = require('path');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const WebpackBar = require('webpackbar');

function getWebpackConfig(config,
  { buildId, dev, isServer, defaultLoaders, nextRuntime, webpack }) {
  const isProd = config.mode === 'production';
  const isPlayBuild = process.env.BOX_PLAY_BUILD === 'true';

  const plugins = [
    new WebpackBar({
      name: config.name
    }),
    new webpack.IgnorePlugin({ resourceRegExp: new RegExp(/assets\/server/) }),
  ];

  // Monaco is requested by the browser from `/_next/static/vs`.  Creator,
  // Play and Player Service each use a separate NEXT_DIST_DIR in development,
  // so writing to a hard-coded `.next` leaves Creator without the loader.
  // Only the client compiler owns browser static assets.
  if (!isPlayBuild && !isServer) {
    plugins.push(new CopyWebpackPlugin({
      patterns: [
        {
          from: join(
            dirname(require.resolve('monaco-editor/package.json')),
            'min/vs',
          ),
          // `output.path` is not the public Next dist directory for every
          // compiler (notably the server compiler).  NEXT_DIST_DIR is the
          // shared source of truth used by next.config.js and dev-all.
          to: join(
            __dirname,
            '..',
            process.env.NEXT_DIST_DIR || '.next',
            'static',
            'vs',
          ),
          // Terser skip this file for minimization
          info: { minimized: true },
        },
      ],
    }));
  }

  // Player-only entry replacements are a product-mode decision, not a
  // compiler-side decision. The previous `else` was paired with the
  // client-only Monaco copy condition, so Creator's server compiler was
  // incorrectly given the Play entry points. That produces incompatible
  // server/client editor output and leaves the Creator page black.
  if (isPlayBuild) {
    const playerOnlyRoot = join(__dirname, '../src/player-only');
    plugins.push(
      new webpack.NormalModuleReplacementPlugin(
        /^src\/entry\/editor-page$/,
        join(playerOnlyRoot, 'editor-page.tsx'),
      ),
      new webpack.NormalModuleReplacementPlugin(
        /^src\/entry\/admin-client$/,
        join(playerOnlyRoot, 'admin-client.ts'),
      ),
      new webpack.NormalModuleReplacementPlugin(
        /^src\/entry\/admin-ui$/,
        join(playerOnlyRoot, 'admin-ui.ts'),
      ),
    );
  }

  if (isProd) {
    plugins.push(
      new webpack.NormalModuleReplacementPlugin(/regl\.js$/, './regl.min.js'),
    );
  }
  const rules = [
    {
      test: /\.(glsl|vs|fs|vert|frag)$/,
      exclude: /node_modules/,
      type: 'asset/source',
      use: ['glslify-loader'],
    },
    {
      test: /\.svg$/i,
      issuer: /\.[jt]sx?$/,
      use: [
        {
          loader: '@svgr/webpack',
          options: {
            svgo: false,
          },
        },
      ],
    },
    {
      // 处理 Script API 的类型文件，用于在编辑器提供代码提示
      test: /\.dts$/i,
      type: 'asset/source'
    },
    {
      test: /\.wgsl$/i,
      type: 'asset/source',
    },
    {
      test: /\.(ttf|otf|woff|woff2)/,
      type: 'asset/resource',
    },
    {
      test: /\.gl(b|tf)$/i,
      type: 'asset/resource',
    }
  ];
  config.resolve = {
    ...config.resolve,
    alias: {
      ...config.resolve?.alias,
      ...(isPlayBuild
        ? {
            'src/entry/editor-page': join(
              __dirname,
              '../src/player-only/editor-page.tsx',
            ),
            'src/entry/admin-client': join(
              __dirname,
              '../src/player-only/admin-client.ts',
            ),
            'src/entry/admin-ui': join(
              __dirname,
              '../src/player-only/admin-ui.ts',
            ),
          }
        : {}),
    },
    fallback: {
      ...config.resolve?.fallback,
      "fs": false
    }
  }
  config.plugins.push(...plugins);
  config.module.rules.push(...rules);
  return config;
}

module.exports = getWebpackConfig;
