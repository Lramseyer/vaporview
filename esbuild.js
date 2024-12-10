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

      await Promise.all([
        extensionCtx.watch(),
        webviewCtx.watch(),
        workerCtx.watch()
      ]);
    } else {
      await Promise.all([
        esbuild.build(extensionConfig),
        esbuild.build(webviewConfig),
        esbuild.build(workerConfig)
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

