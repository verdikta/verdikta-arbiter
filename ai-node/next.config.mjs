/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    // Add externals for packages with native dependencies that should be dynamically imported
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push({
        'textract': 'commonjs textract',
        'mammoth': 'commonjs mammoth',
      });
    }
    
    return config;
  },
  // Enable instrumentation for custom error filtering
  experimental: {
    instrumentationHook: true,
  },
  // Suppress noisy server action errors in development
  onDemandEntries: {
    maxInactiveAge: 60 * 1000,
    pagesBufferLength: 5,
  },
  // Custom logging to suppress specific error patterns
  logging: {
    fetches: {
      fullUrl: false,
    },
  },
};

export default nextConfig;
