import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  // Workers AI only runs on Cloudflare (remote). CI has no Cloudflare login, so skip remote bindings
  // there; the app falls back to keyword labeling when AI isn't available.
  plugins: [react(), tailwindcss(), cloudflare({ remoteBindings: !process.env.CI })],
});
