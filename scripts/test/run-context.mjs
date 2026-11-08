import { AsyncLocalStorage } from 'node:async_hooks';

// Tests and evaluations share an execution scope, never global output-directory defaults.
const contexts = new AsyncLocalStorage();
export const withRunContext = (context, run) => contexts.run(context, run);
export function runContext() {
  const context = contexts.getStore();
  if (!context)
    throw new Error('No artifact execution context; prepare artifacts before launching');
  return context;
}
export const testAppDir = () => runContext().appDir;
export const testBuildDir = () => runContext().buildDir;
export const testBundle = () => runContext().bundlePath;
