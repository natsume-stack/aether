const { resolve, join } = require('path');
const { existsSync } = require('fs');
const webpack = require('webpack');
const WebpackBar = require('webpackbar');
const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');
const { config: dotenvConfig } = require('dotenv');
const FileManagerPlugin = require('filemanager-webpack-plugin');

/**
 * 入口文件字典
 * 为了让rusty_box能正常使用worker，需要把worker文件作为单独编译
 */
const ENTRIES = {
  main: './src/client/rusty/main.ts',
  ['voxel.worker']: './src/engine/voxel/voxel.worker.ts',
  ['particle.worker']: './src/engine/particle/particle.worker.ts',
};

/**
 * 资源地址
 * 打包出来的文件会复制到public目录下作为静态资源
 * 让页面用script直接加载js
 *
 * 放到dist/play-client是因为dist目录不会被git提交
 */
const WEB_PUBLIC_PATH = 'dist/play-client/';
/**
 * next.js服务中，打包出来的js存放路径
 * FileManagerPlugin会把打包出来的文件拷贝到该目录下
 */
const NEXT_WEB_PUBLIC_PATH = `public/${WEB_PUBLIC_PATH}`;

function getWebpackConfig() {
  const mode =
    process.env.NODE_ENV === 'production' ? 'production' : 'development';

  let devtool = false;

  const plugins = [
    new WebpackBar({ name: 'play-client' }),
    /**
     * 有部分代码会直接调用Buffer.XXX，不会显示引入Buffer（import {Buffer} from 'buffer'）
     */
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser',
    }),
    new webpack.DefinePlugin(getDefineSpec()),
    /**
     * 不打包出额外的common chunk js文件
     *
     * rusty_box不支持script标签加载js文件
     * 但worker需要被打包
     */
    new webpack.optimize.LimitChunkCountPlugin({
      maxChunks: Object.keys(ENTRIES).length,
    }),
    /**
     * 把js文件复制到public目录作为公共资源
     * 调试时，让调试页面直接引用js文件，模拟rusty_box项目的使用
     */
    new FileManagerPlugin({
      events: {
        onEnd: {
          delete: [NEXT_WEB_PUBLIC_PATH],
          copy: [
            { source: WEB_PUBLIC_PATH, destination: NEXT_WEB_PUBLIC_PATH },
          ],
        },
      },
    }),
  ];

  if (mode !== 'production') {
    devtool = 'inline-source-map';
  }

  if (process.env.ANALYZE) {
    plugins.push(new BundleAnalyzerPlugin());
  }

  return {
    mode,
    devtool,
    entry: ENTRIES,
    output: {
      path: resolve(__dirname, `../${WEB_PUBLIC_PATH}`),
      filename: '[name].js',
      publicPath: './',
      clean: true,
    },
    module: {
      rules: [
        {
          test: /\.(ts|dts)/,
          exclude: /node_modules/,
          use: [
            {
              loader: 'ts-loader',
              options: {
                configFile: resolve(__dirname, './tsconfig.json'),
                transpileOnly: true,
              },
            },
          ],
        },
        {
          test: /\.wgsl$/i,
          type: 'asset/source',
        },
        {
          test: /\.(jpg|jpeg|png|gif|svg|ico)/,
          type: 'asset/resource',
        },
        {
          test: /\.(ttf|otf|woff|woff2)/,
          type: 'asset/resource',
        },
        {
          test: /\.s[ac]ss$/i,
          use: [
            // Creates `style` nodes from JS strings
            'style-loader',
            // Translates CSS into CommonJS
            {
              loader: 'css-loader',
              options: {
                modules: {
                  /**
                   * 禁用该选项，以保持和next.js的scss导入语法保持一致
                   */
                  namedExport: false,
                },
                /**
                 * TODO
                 * 这里设置false是因为css url引入的图片会产生webpack jsonp代码
                 * 会生成__webpack_require__.b，也就是这行代码：
                 * __webpack_require__.b = document.baseURI || self.location.href
                 *
                 * rusty_box中既没有document，也没有self和location，会立即出错
                 *
                 * 这里先设url为false，忽略掉css中引入的图片。
                 *
                 * 目前只会影响对话框输入（InputDialog）的输入框，输入时，其右侧有个x按钮，用的是雪碧图。
                 * 先不管吧。问题不大。
                 */
                url: false,
              },
            },
            // Compiles Sass to CSS
            'sass-loader',
          ],
        },
      ],
    },
    plugins,
    resolve: {
      alias: {
        src: resolve(__dirname, '../src'),
        assets: resolve(__dirname, '../assets'),
      },
      extensions: ['.js', '.ts'],
      fallback: {
        'crypto': require.resolve('crypto-browserify'),
        'stream': require.resolve('stream-browserify'),
        'buffer': require.resolve('buffer/'),
        'process/browser': require.resolve('process/browser'),
        "path": false,
        "vm": require.resolve('vm-browserify'),
        "querystring": require.resolve('querystring-es3'),
      },
    },
    watchOptions: {
      ignored: ['../dist'],
    },
  };
}

/**
 * 注入内置变量、以及读取.env的变量
 */
function getDefineSpec() {
  const env = {
    'process.env.RUSTY': JSON.stringify(true),
    'process.env.WEB_PUBLIC_PATH': JSON.stringify(WEB_PUBLIC_PATH),
  };

  const mergeParsed = (parsed) => {
    Object.entries(parsed).forEach(([key, value]) => {
      env[`process.env.${key}`] = JSON.stringify(value);
    });
  };

  const envConfig = dotenvConfig({ path: join(__dirname, '.env.prod') });

  envConfig.parsed && mergeParsed(envConfig.parsed);

  // 如果有.env.local，用.env.local覆盖配置
  const localEnvPath = join(__dirname, '.env.local');
  if (existsSync(localEnvPath)) {
    const localEnvConfig = dotenvConfig({ path: localEnvPath });

    localEnvConfig.parsed && mergeParsed(localEnvConfig.parsed);
  }

  return env;
}

module.exports = getWebpackConfig();
