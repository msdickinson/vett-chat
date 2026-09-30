import { render } from 'preact';
import { LauncherApp } from './launcher/LauncherApp';

const root = document.getElementById('root');
if (root) {
  render(<LauncherApp />, root);
}
