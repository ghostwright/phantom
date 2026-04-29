import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/chat/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/chat/stream": "http://localhost:3100",
      "/chat/sessions": "http://localhost:3100",
      "/chat/bootstrap": "http://localhost:3100",
      "/chat/events": "http://localhost:3100",
      "/chat/focus": "http://localhost:3100",
      "/chat/push": "http://localhost:3100",
      "/login": "http://localhost:3100",
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-cmdk": ["cmdk"],
        },
      },
    },
  },
});
