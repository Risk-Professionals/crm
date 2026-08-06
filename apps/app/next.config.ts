import { fileURLToPath } from "node:url";
import { loadRootEnv } from "@crm/env";
import type { NextConfig } from "next";

loadRootEnv();

const nextConfig: NextConfig = {
	output: "standalone",
	outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),

	transpilePackages: ["@crm/auth", "@crm/db", "@crm/ui"],

	serverExternalPackages: [
		"@crm/env",
		"@prisma/client",
		"@prisma/adapter-pg",
		"pg",
	],

	images: {
		remotePatterns: [
			{ protocol: "https", hostname: "**.blob.vercel-storage.com" },
		],
	},

	cacheComponents: true,
	partialPrefetching: true,
};

export default nextConfig;
