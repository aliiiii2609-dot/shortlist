import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // the CV templates embed their imagery as base64, so the bundle is large
    // by design; this silences Vite's advisory warning rather than hiding a problem
    chunkSizeWarningLimit: 4000,
  },
});
