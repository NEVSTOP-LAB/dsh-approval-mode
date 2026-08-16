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
 *     so it persists across restarts.
 *   - The client half reads/writes the mode through a small HTTP route
 *     (`GET/POST /approval-mode`) registered on the public webServer service.
 *     The settings RPC surface is NOT used: its namespace allowlist
 *     (WEB_SETTINGS_NAMESPACES in dsh-host-apiproxy) is hard-coded and
 *     third-party namespaces are refused with `settings-not-exposed`.
 *   - On mode change, every live agent is notified via an injected message.
 *
 * The client half (lib/client.js) renders the mode picker next to the
 * permission selector; see doc/design.md for the full design.
 */
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name (also the bundle row id). */
export const name = "dsh-approval-mode";

/** Required services: settings (mode storage), webServer (control route). */
export const inject = ["settings", "webServer"];

/** Settings namespace holding the approval mode. */
export const NS = "approval-mode";

/** Schemastery schema for the namespace: mode is "ask" (default) or "bypass". */
export const MODE_SCHEMA = z.object({
  mode: z.union(["ask", "bypass"]).default("ask")
});

/** Control route path served by this plugin. */
export const ROUTE_PATH = "/approval-mode";

/**
 * Resolve the effective mode from a settings value.
 * @param value - resolved settings value for {@link NS}.
 * @returns "ask" | "bypass"
 */
export function modeOf(value) {
  return value && value.mode === "bypass" ? "bypass" : "ask";
}

/** Whether an HTTP request arrives from a loopback authority (defense for 0.0.0.0 deployments). */
function isLoopbackRequest(req) {
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    if (hostname === "localhost" || hostname === "[::1]") return true;
    const parts = hostname.split(".");
    return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  } catch {
    return false;
  }
}

/** Read the full request body (bounded). */
function readBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function apply(ctx) {
  ctx.settings.register(NS, MODE_SCHEMA, { applies: "live" });

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

  /**
   * Control route: GET returns the current mode; POST { mode } switches it.
   * Loopback-only (same trust posture as the /api fence).
   */
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: ROUTE_PATH,
    handler: async (req, res) => {
      const writeJson = (status, body) => {
        const text = JSON.stringify(body);
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(text);
      };
      if (!isLoopbackRequest(req)) {
        writeJson(403, { ok: false, error: "forbidden" });
        return;
      }
      if (req.method === "GET") {
        writeJson(200, { ok: true, mode: modeOf(ctx.settings.get(NS)), defaultMode: "ask" });
        return;
      }
      if (req.method !== "POST") {
        writeJson(405, { ok: false, error: "method-not-allowed" });
        return;
      }
      let parsed;
      try {
        const body = await readBody(req);
        parsed = body.length === 0 ? {} : JSON.parse(body);
      } catch {
        writeJson(400, { ok: false, error: "bad-json" });
        return;
      }
      const mode = parsed && parsed.mode;
      if (mode !== "ask" && mode !== "bypass") {
        writeJson(400, { ok: false, error: "invalid-mode", mode });
        return;
      }
      const prev = modeOf(ctx.settings.get(NS));
      if (prev === mode) {
        writeJson(200, { ok: true, mode, changed: false });
        return;
      }
      try {
        await ctx.settings.update(NS, { mode });
        writeJson(200, { ok: true, mode, changed: true });
      } catch (err) {
        console.error("[dsh-approval-mode] settings update failed:", err);
        writeJson(500, { ok: false, error: "settings-update-failed" });
      }
    }
  }), "dsh-approval-mode: control route");

  /** Notify every live agent when the user switches the mode. */
  ctx.on("settings/updated", (ns, next, prev, source) => {
    if (ns !== NS) return;
    const mode = modeOf(next);
    console.log(`[dsh-approval-mode] settings/updated: mode = ${mode}`);
    // 通知文案跟随 DSH 语言（locale settings preference；缺省回退中文）
    const locale = ctx.settings.get("locale");
    const en = locale && locale.preference === "en";
    const text = en
      ? `The approval mode was switched to "${mode === "bypass" ? "bypass approval (every tool call is auto-approved)" : "default approval (tool calls require a click to approve)"}".`
      : `审批模式已由用户切换为「${mode === "bypass" ? "绕过审批（所有工具调用自动批准）" : "默认审批（工具调用需要点击审批）"}」。`;
    const agents = ctx.get("agents");
    if (!agents || typeof agents.list !== "function") return;
    for (const agent of agents.list()) {
      try {
        if (agent && typeof agent.inject === "function") {
          agent.inject({
            role: "user",
            content: [{ type: "text", text }],
            source: { kind: "plugin", plugin: "approval-mode" }
          });
        }
      } catch (err) {
        console.error("[dsh-approval-mode] agent notify error:", err);
      }
    }
  });
}
