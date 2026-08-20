import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "host/index": "./src/host/index.js",
    "host/config": "./src/host/config.js"
  },
  format: "esm",
  clean: true,
  outDir: "lib"
});
