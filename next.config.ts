import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // @wagmi/connectors -> @base-org/account -> @coinbase/cdp-sdk declares
    // optional "@x402/*" imports that are not installed; stub them out.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/core": false,
      "@x402/evm": false,
      "@x402/svm": false,
      "@x402/fetch": false,
      "@x402/express": false,
      "@x402/extensions": false,
    };
    return config;
  },
};

export default nextConfig;
