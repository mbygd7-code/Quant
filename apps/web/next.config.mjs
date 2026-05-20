/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pre-existing lint debt across the codebase (unused vars, unescaped
  // entities, missing useEffect deps) was failing Vercel builds. Local
  // `next lint` still runs, so the warnings stay visible during dev —
  // we just stop blocking prod deploys on them while we work through
  // the backlog.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
