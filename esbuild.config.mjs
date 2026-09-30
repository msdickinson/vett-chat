import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

// Extension host (Node.js, CommonJS)
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
};

// Webview (Browser, IIFE) — chat panel
const webviewConfig = {
  entryPoints: ['webview/index.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  jsx: 'automatic',
  jsxImportSource: 'preact',
};

// Sidebar launcher — separate Preact app, separate bundle, kept small
// so the activity-bar click is instant and never blocks on the chat
// app's lazy state.
const launcherConfig = {
  ...webviewConfig,
  entryPoints: ['webview/launcher.tsx'],
  outfile: 'dist/launcher.js',
};

if (isWatch) {
  const extCtx = await esbuild.context(extensionConfig);
  const webCtx = await esbuild.context(webviewConfig);
  const launchCtx = await esbuild.context(launcherConfig);
  await Promise.all([extCtx.watch(), webCtx.watch(), launchCtx.watch()]);
  console.log('Watching for changes...');
} else {
  await esbuild.build(extensionConfig);
  await esbuild.build(webviewConfig);
  await esbuild.build(launcherConfig);
  console.log('Build complete.');
}
