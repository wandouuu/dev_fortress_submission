import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  build: {
    // Output a single self-contained HTML file with inlined JS+CSS
    // This is what the MCP server reads and serves as the widget resource
    rollupOptions: {
      input: resolve(__dirname, "index.html"),
      output: {
        // Single JS bundle
        entryFileNames: "widget.js",
        chunkFileNames: "widget-[hash].js",
        assetFileNames: "widget.[ext]",
      },
    },
    outDir: "dist",
    emptyOutDir: true,
    // Inline all assets under 100kb to keep everything self-contained
    assetsInlineLimit: 102400,
  },
});
