/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['jspdf'],
  // Leaflet accesses `window` at import time; tell webpack to ignore it server-side
  webpack(config, { isServer }) {
    if (isServer) {
      config.externals = [...(config.externals ?? []), 'leaflet', 'react-leaflet']
    }
    return config
  },
}

module.exports = nextConfig
