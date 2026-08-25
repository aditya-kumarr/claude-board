import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const API_TARGET = `http://127.0.0.1:${process.env.PORT ?? 4000}`;
// The tunnel hostname must be allow-listed or Vite rejects the request as a DNS-rebind
// attempt. Production serves the built SPA from Express, so this only matters for `dev`.
const TUNNEL_HOSTNAME = process.env.TUNNEL_HOSTNAME?.trim();

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    // Bind every interface when a tunnel or LAN client needs to reach the dev server.
    host: (TUNNEL_HOSTNAME ?? process.env.HOST) ? true : "localhost",
    allowedHosts: TUNNEL_HOSTNAME ? [TUNNEL_HOSTNAME] : undefined,
    // Same-origin /api in dev, so the client never needs a base URL or CORS.
    proxy: { "/api": { target: API_TARGET, changeOrigin: true } },
    // HMR must dial the tunnel over wss:443, not the raw dev port.
    hmr: TUNNEL_HOSTNAME ? { host: TUNNEL_HOSTNAME, protocol: "wss", clientPort: 443 } : undefined,
  },
  build: { outDir: "dist", sourcemap: true },
});
