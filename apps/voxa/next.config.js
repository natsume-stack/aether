// 直接解析部分包的 ES6 / TS 代码
/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  productionBrowserSourceMaps: false,
  eslint: {
    ignoreDuringBuilds: true,
  },
  transpilePackages: [
    '@box/regl',
    '@box/env',
    '@box/apis',
    '@box/vb',
    '@box/schema',
  ],
  // VOXA owns long-lived WebGL/regl resources. React Strict Mode intentionally
  // remounts effects in development, which can destroy a buffer while the
  // renderer's frame loop still holds it and produces `Vertex buffer is null`.
  // Keep the production safety check while avoiding the dev-only double mount.
  reactStrictMode: process.env.NODE_ENV === 'production',
  headers() {
    return [
      {
        source: '/:path*',
        // 添加安全性 header 启用内存监控相关的 API
        headers: [
          {
            key: 'Cross-Origin-Resource-Policy',
            value: 'cross-origin',
          },
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'credentialless',
          }
        ],
      }
    ]
  },
  typescript: {
    // 升级 react 前临时使用
    ignoreBuildErrors: true,
  },
  webpack: (config, options) => {
    config.module.rules.push({
      test: /\.(glsl|vs|fs|vert|frag)$/,
      exclude: /node_modules/,
      type: 'asset/source',
      use: ['glslify-loader'],
    });

    /**
     * 把icon的svg symbol以文本形式读取。
     */
    config.module.rules.push({
      test: /\.svg/,
      include: /assets\/icons/,
      type: 'asset/source',
    });

    /**
     * 使用svgr读取独立的svg（不属于icon）
     * https://react-svgr.com/docs/next/
     */
    config.module.rules.push({
      test: /\.svg$/i,
      exclude: /assets\/icons/,
      issuer: /\.[jt]sx?$/,
      use: ['@svgr/webpack'],
    });

    config.module.rules.push({
      test: /\.mp4/,
      include: /src/,
      type: 'asset/resource',
    });

    // https://formatjs.io/docs/guides/advanced-usage#react-intl-without-parser-40-smaller
    config.resolve.alias['@formatjs/icu-messageformat-parser'] =
      '@formatjs/icu-messageformat-parser/no-parser';

    /**
     * support @dqbd/tiktoken used by langchain
     * see: https://js.langchain.com/docs/getting-started/install#vercel--nextjs
     */
    config.experiments = {
      asyncWebAssembly: true,
      layers: true,
    };

    return require('@box/deployment-routing/next-webpack')(config,{...options,dir:__dirname});
  },
  // https://nextjs.org/docs/messages/next-image-unconfigured-host
  // TODO 新版本的Next.js支持remotePatterns方式设置
  images: { unoptimized: true },
};

module.exports = nextConfig;
