import { defineConfig } from "vite";

// GeoLibre loads an external plugin with
// `import(URL.createObjectURL(blob))`, so the entry has to be one
// self-contained ES module: relative imports are never resolved at runtime and
// bare specifiers have no import map. Everything therefore gets inlined —
// including the R engine, which is pulled in as a raw string.
//
// The one deliberate exception is webR's WebAssembly payload (~40 MB of R
// itself). That cannot live inside a JS module, so it is fetched at runtime
// from the URL configured in `src/config.ts`.
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    // Readable output keeps plugin review (the registry is an allowlist)
    // tractable; the publishing CI whitespace-minifies bundles anyway.
    minify: false,
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: (asset) =>
          asset.names?.some((n) => n.endsWith(".css")) ? "style.css" : "[name][extname]",
      },
    },
  },
  resolve: {
    // Force the browser build of webR; its package exports also expose a Node
    // entry that would drag `node:` builtins into the bundle.
    conditions: ["browser", "import", "module", "default"],
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    // webR's browser build still carries one Node-only branch that reads
    // `__dirname` (its base URL when running under Node). Never taken in a
    // browser, but the plugin registry's validator imports the bundle under
    // Node, where a bare `__dirname` in an ES module is a ReferenceError.
    __dirname: JSON.stringify(""),
  },
});
