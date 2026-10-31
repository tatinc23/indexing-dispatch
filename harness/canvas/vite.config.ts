// Dev-only harness for the submission canvas. Never built or shipped by `mcp-use build`.
// Run: npx vite --config harness/canvas/vite.config.ts   (then open /?cf=1&ps=1)
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { port: 5199, strictPort: true },
});
