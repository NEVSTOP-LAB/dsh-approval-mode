/**
 * dsh-approval-mode — Host half.
 *
 * Provides the "绕过审批" (bypass) mode as a third approval state on top of
 * DSH's built-in ask/never policies:
 *
 *   - An approval/request answerer registered at the FRONT of the waterfall
 *     (`prepend: true`): in bypass mode it returns "allowed-once" directly,
 *     so the request never reaches the GUI answerer and no prompt appears;
 *     in ask mode it calls next() and the stock flow (click-to-approve) runs.
 *   - The mode lives in the DSH settings service (namespace "approval-mode"),
 *     so it persists across restarts and is readable/writable by the client
 *     half through the standard settings RPC (settings.describe / mutate).
 *   - On mode change, every live agent is notified via an injected message.
 *
 * The client half (lib/client.js) renders the mode picker next to the
 * permission selector; see doc/design.md for the full design.
 */
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name (also the bundle row id). */
export const name = "dsh-approval-mode";

/** Required services: settings (mode storage). */
export const inject = ["settings"];

/** Settings namespace holding the approval mode. */
export const NS = "approval-mode";

/** Schemastery schema for the namespace: mode is "ask" (default) or "bypass". */
export const MODE_SCHEMA = z.object({
  mode: z.union(["ask", "bypass"]).default("ask")
});

/**
 * Resolve the effective mode from a settings value.
 * @param value - resolved settings value for {@link NS}.
 * @returns "ask" | "bypass"
 */
export function modeOf(value) {
  return value && value.mode === "bypass" ? "bypass" : "ask";
}

export function apply(ctx) {
  console.log("[dsh-approval-mode] apply: registering settings namespace", NS);
  ctx.settings.register(NS, MODE_SCHEMA, { applies: "live" });
  console.log("[dsh-approval-mode] apply: settings registered; resolved =", JSON.stringify(ctx.settings.get(NS)));

  /**
   * Front-of-chain approval answerer (prepend). DSH's GUI answerer
   * (dsh-host-apiproxy) always claims pending approvals and waits for a
   * client click; registering before it lets bypass mode settle the decision
   * without ever broadcasting an approval/requested frame.
   */
  ctx.on("approval/request", async (req, next) => {
    try {
      if (modeOf(ctx.settings.get(NS)) === "bypass") {
        const session = req && req.agent && req.agent.session;
        console.log(`[dsh-approval-mode] bypass: auto-approved ${req && req.toolName ? req.toolName : "(unknown tool)"}${session ? ` @ ${session.id}` : ""}`);
        return "allowed-once";
      }
    } catch (err) {
      console.error("[dsh-approval-mode] answerer error:", err);
    }
    return next();
  }, true);
  console.log("[dsh-approval-mode] apply: approval answerer registered (prepend)");

  /** Notify every live agent when the user switches the mode. */
  ctx.on("settings/updated", (ns, next, prev, source) => {
    if (ns !== NS) return;
    const mode = modeOf(next);
    console.log(`[dsh-approval-mode] settings/updated: mode = ${mode}`);
    const agents = ctx.get("agents");
    if (!agents || typeof agents.list !== "function") return;
    for (const agent of agents.list()) {
      try {
        if (agent && typeof agent.inject === "function") {
          agent.inject({
            role: "user",
            content: [{
              type: "text",
              text: `审批模式已由用户切换为「${mode === "bypass" ? "绕过审批（所有工具调用自动批准）" : "默认审批（工具调用需要点击审批）"}」。`
            }],
            source: { kind: "plugin", plugin: "approval-mode" }
          });
        }
      } catch (err) {
        console.error("[dsh-approval-mode] agent notify error:", err);
      }
    }
  });
  console.log("[dsh-approval-mode] apply: settings/updated listener registered");
}
