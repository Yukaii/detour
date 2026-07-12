import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon-1024.png"],
      manifest: {
        name: "Detour - Montreal BIXI routes",
        short_name: "Detour",
        description: "Live BIXI availability and comfortable Montreal bike routes.",
        theme_color: "#f7f8f5",
        background_color: "#f7f8f5",
        display: "standalone",
        orientation: "portrait",
        start_url: ".",
        icons: [
          { src: "icon-1024.png", sizes: "1024x1024", type: "image/png", purpose: "any" },
          { src: "icon-1024.png", sizes: "1024x1024", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/basemaps\.cartocdn\.com\//,
            handler: "CacheFirst",
            options: { cacheName: "detour-map", expiration: { maxEntries: 180, maxAgeSeconds: 604800 } }
          }
        ]
      }
    })
  ]
});
