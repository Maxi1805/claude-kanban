import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

// Vite is rooted at `web/`. The shared contracts live one level up in
// `../src/shared`, exposed via the `@shared` alias. Dev requests to /api and
// /ws are proxied to the backend on :8787.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("../src/shared", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/ws": {
        target: "http://localhost:8787",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
