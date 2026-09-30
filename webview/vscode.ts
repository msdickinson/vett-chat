interface VSCodeAPI {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

// acquireVsCodeApi is injected by VS Code into the webview scope. Declare
// it globally so the strict tsc check doesn't fail; at runtime we still
// guard against reload/test contexts where it may not exist.
declare const acquireVsCodeApi: (() => VSCodeAPI) | undefined;

let vscode: VSCodeAPI;
if (typeof acquireVsCodeApi === 'function') {
  vscode = acquireVsCodeApi();
} else {
  // Fallback for testing or unexpected reload — no-op.
  vscode = {
    postMessage: () => {},
    getState: () => undefined,
    setState: () => {},
  };
}

export default vscode;
