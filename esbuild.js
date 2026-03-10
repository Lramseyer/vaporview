const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd(result => {
      console.log(`Build ${build.initialOptions.outfile} finished`);
      if (result.errors.length) {
        result.errors.forEach(error => {
          console.error(error);
        });
      }
    });
  }
};

const commonConfig = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const extensionConfig = {
  ...commonConfig,
  entryPoints: ['src/extension_core/extension.ts'],
  format: 'cjs',
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode'], // Only external we actually need
  alias: {
    // vscode-shiki-bridge ships ESM as its default export, which can't be
    // bundled into a CJS output. Point esbuild at the CJS build instead.
    'vscode-shiki-bridge': './node_modules/vscode-shiki-bridge/dist/index.cjs',
    // jsonc-parser's UMD entry passes the real Node require() into its factory,
    // so internal require('./impl/format') calls escape esbuild's module system
    // and fail at runtime. Use the ESM entry so esbuild can bundle it statically.
    'jsonc-parser': './node_modules/jsonc-parser/lib/esm/main.js',
  },
  plugins: [esbuildProblemMatcherPlugin],
};

const workerConfig = {
  ...commonConfig,
  entryPoints: ['src/extension_core/worker.ts'],
  format: 'iife', // Self-executing function for worker scope
  platform: 'node',
  outfile: 'dist/worker.js',
  plugins: [esbuildProblemMatcherPlugin],
  target: 'es2020', // Modern browsers support WASM
};

const fsdbWorkerConfig = {
  ...commonConfig,
  entryPoints: ['src/extension_core/fsdb_worker.ts'],
  format: 'iife', // Self-executing function for worker scope
  platform: 'node',
  outfile: 'dist/fsdb_worker.js',
  external: ['../build/Release/fsdb_reader.node'],
  plugins: [esbuildProblemMatcherPlugin],
  target: 'es2020', // Modern browsers support WASM
};

const webviewConfig = {
  ...commonConfig,
  entryPoints: ['src/webview/vaporview.ts'],
  format: 'iife',
  platform: 'browser',
  outfile: 'dist/webview.js',
  plugins: [esbuildProblemMatcherPlugin],
  target: ['es2020'],
  treeShaking: production,
  metafile: true, // To analyze bundle
};

async function main() {
  try {
    if (watch) {
      const extensionCtx = await esbuild.context(extensionConfig);
      const webviewCtx = await esbuild.context(webviewConfig);
      const workerCtx = await esbuild.context(workerConfig);
      const fsdbWorkerCtx = await esbuild.context(fsdbWorkerConfig);

      await Promise.all([
        extensionCtx.watch(),
        webviewCtx.watch(),
        workerCtx.watch(),
        fsdbWorkerCtx.watch()
      ]);
    } else {
      await Promise.all([
        esbuild.build(extensionConfig),
        esbuild.build(webviewConfig),
        esbuild.build(workerConfig),
        esbuild.build(fsdbWorkerConfig)
      ]);
    }
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}


main().catch(e => {
  console.error(e);
  process.exit(1);
});

