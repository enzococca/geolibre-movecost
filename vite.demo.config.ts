import { defineConfig } from "vite";

/**
 * Dev server for `examples/` — a plain page that drives the same engine the
 * plugin uses, without GeoLibre in the way. It is how both backends get
 * exercised end to end: the local R service over HTTP, and webR in the page.
 *
 *   npm run serve:demo   ->  http://localhost:5174
 */
export default defineConfig({
  root: "examples",
  publicDir: "public",
  resolve: { conditions: ["browser", "import", "module", "default"] },
  server: {
    port: 5174,
    strictPort: true,
    // webR needs SharedArrayBuffer for its blocking channel, and the browser
    // only exposes it on a cross-origin-isolated page. `credentialless` lets the
    // wasm and package archives still load from r-wasm.org, which does not send
    // CORP headers of its own.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
    // Same-origin path to the local R service, for browsers and embedded
    // webviews that refuse cross-origin requests to loopback ports. Point the
    // demo at it from the console with:
    //   localStorage.setItem("MOVECOST_BACKEND_URL", location.origin + "/api")
    proxy: {
      "/api": {
        target: process.env.MOVECOST_BACKEND_URL ?? "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
