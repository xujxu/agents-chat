import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3', 'hyco-ws', 'pino', 'pino-roll', 'pino-pretty'],
  // pino loads its transports (and pino/lib/worker.js's own deps) in a worker thread, so file tracing never sees them.
  outputFileTracingIncludes: {
    '/**': [
      './node_modules/pino-roll/**/*.js',
      './node_modules/pino-roll/package.json',
      './node_modules/pino-abstract-transport/**/*.js',
      './node_modules/pino-abstract-transport/package.json',
      './node_modules/split2/**/*.js',
      './node_modules/split2/package.json',
      './node_modules/process-warning/**/*.js',
      './node_modules/process-warning/package.json',
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
