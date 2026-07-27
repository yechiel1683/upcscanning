import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // sharp / archiver / bullmq are native or Node-only; keep them external to the
  // server bundle so Next does not try to trace and re-bundle their binaries.
  serverExternalPackages: ['sharp', 'archiver', 'bullmq', 'ioredis', 'exceljs', '@prisma/client'],
  experimental: {
    // Spreadsheets can be large; uploads stream through a route handler.
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },
};

export default config;
