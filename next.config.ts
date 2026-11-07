import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3', 'hyco-ws', 'pino', 'pino-roll', 'pino-pretty'],
  // pino loads the pino-roll transport by name in a worker thread, so file tracing never sees it.
  outputFileTracingIncludes: {
    '/**': [
      './node_modules/pino-roll/**/*.js',
      './node_modules/pino-roll/package.json',
      './node_modules/date-fns/**/*.cjs',
      './node_modules/date-fns/package.json',
    ],
  },
  allowedDevOrigins: [
    'oldest-eating-spice-restoration.trycloudflare.com',
    'headphones-frequency-routers-liked.trycloudflare.com',
  ],
};

export default nextConfig;
