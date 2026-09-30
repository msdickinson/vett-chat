import { render } from 'preact';
import { App } from './App';

const root = document.getElementById('root');
if (root) {
  // Defensive wipe before mounting. If this bundle ever runs twice in
  // the same webview context — which can happen when VS Code re-sets
  // webview.html on a retained webview, or when the bundle gets
  // injected twice via some race — Preact's module-fresh state would
  // otherwise append a *second* tree alongside the first instead of
  // reconciling, producing the "live stuff copies again and again"
  // symptom that started showing up around sub-agent dispatch.
  root.innerHTML = '';
  render(<App />, root);
}
