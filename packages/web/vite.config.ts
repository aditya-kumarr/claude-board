import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const API_TARGET = `http://127.0.0.1:${process.env.PORT ?? 4000}`;

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    // Same-origin /api in dev, so the client never needs a base URL or CORS.
    proxy: { "/api": { target: API_TARGET, changeOrigin: true } },
  },
  build: { outDir: "dist", sourcemap: true },
});
