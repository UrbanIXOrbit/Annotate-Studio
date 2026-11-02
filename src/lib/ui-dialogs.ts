import { confirm } from '@tauri-apps/plugin-dialog';
import { isTauri } from './tauri-commands';

/**
 * Confirmation that works inside the Tauri webview.
 *
 * The dialog plugin's init script replaces `window.confirm` with an async
 * wrapper that returns a *Promise* — a Promise is always truthy, so a plain
 * `if (confirm(msg))` would act without waiting for the real answer (and
 * `dialog:default` doesn't even include `allow-confirm`, so it also threw).
 * Ask through the plugin directly instead; in a plain browser keep `window.confirm`.
 *
 * Call sites must `await` this — never treat the return value as synchronous.
 */
export async function appConfirm(message: string): Promise<boolean> {
  if (isTauri()) return confirm(message, { title: 'Annotate Studio' });
  return window.confirm(message);
}
