export interface ConsoleBridgeChild {
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}
export interface ConsoleBridgeParent {
  stderr: { write(text: string): unknown };
  exitCode?: number | string;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}
export function runConsoleBridge(
  argv: string[],
  options?: {
    launch?: (file: string, args: string[], options: {
      stdio: 'inherit'; shell: false; windowsHide: true;
    }) => ConsoleBridgeChild;
    parent?: ConsoleBridgeParent;
  },
): ConsoleBridgeChild | undefined;
