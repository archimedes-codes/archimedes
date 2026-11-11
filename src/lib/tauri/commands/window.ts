/**
 * Window state (Linux tiling / snap detection) and the window raise. Two PUSH
 * counterparts live elsewhere: `listenWindowState` in `../events.ts` pushes the
 * frame state, `listenAttentionAlertClicked` pushes the alert click this raise
 * serves; the shape is `WindowFrameState` in `../types.ts`.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  WindowFrameState,
} from "../types";


export async function getWindowState(): Promise<WindowFrameState> {
  return invoke<WindowFrameState>("get_window_state");
}


/** Raise the main window to the foreground (the attention-alert click route):
 *  `unminimize → show → set_focus`, the order pinned on the Rust side. NO
 *  payload — the command takes no arguments (ADR 0039's window raise). */
export async function raiseAttentionWindow(): Promise<void> {
  // Pinned to the ZERO-arg `invoke` in `src/lib/tauri.test.ts`, exactly as
  // `attention_disarm` is: `{}` would be a different call on the wire.
  await invoke("raise_attention_window");
}
