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
};

export default nextConfig;
