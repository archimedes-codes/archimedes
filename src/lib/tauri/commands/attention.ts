/**
 * Attention alerts (ADR 0038/0039 — the countdown lives in Rust). Two commands,
 * one armed alert at a time: arming REPLACES the pending countdown, and disarm is
 * idempotent and called for EVERY disarm reason.
 */

import { invoke } from "@tauri-apps/api/core";


// ---------------------------------------------------------------------------
// Attention alerts (ADR 0038/0039 — the countdown lives in Rust)
// ---------------------------------------------------------------------------

/** Arm the Supervisor's attention countdown (ADR 0039: Rust owns the clock).
 * One armed alert at a time — arming REPLACES the pending countdown.
 * `clickToken` is the session id a body click navigates to (the already-resolved
 * PARENT id — see `attentionAlertText`'s `click_token`); Rust carries it through
 * the notification untouched and hands it back on the click. */
export async function attentionArm(
  delaySecs: number,
  title: string,
  body: string,
  clickToken: string,
): Promise<void> {
  // The arg key `delaySecs` maps to the Rust `delay_secs` parameter, and the
  // delay is passed through EXACTLY (`0` = fire immediately) — no client-side
  // defaulting here: Rust owns the clock and the ceiling. The same mapping rule
  // covers `clickToken` → the Rust `click_token` parameter. The wire contract is
  // pinned in `src/lib/tauri.test.ts`, the only place a typo can be caught.
  await invoke("attention_arm", { delaySecs, title, body, clickToken });
}


/** Disarm the attention countdown. Idempotent; called for EVERY disarm reason. */
export async function attentionDisarm(): Promise<void> {
  // No payload: the Rust command takes only its `State<Arc<AttentionTimer>>`.
  await invoke("attention_disarm");
}
