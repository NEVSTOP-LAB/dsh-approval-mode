/**
 * dsh-approval-mode — Host half.
 *
 * Provides "绕过审批" (bypass) as two further approval states on top of DSH's
 * built-in ask/never policies:
 *
 *   - An approval/request answerer registered at the FRONT of the waterfall
 *     (`prepend: true`): under a bypass mode it returns "allowed-once" before
 *     the request reaches the GUI answerer, so no prompt appears; in ask mode
 *     it calls next() and the stock flow (click-to-approve) runs.
 *   - The three modes are `ask`, `bypass-except-escalation` and `bypass`. The
 *     middle one auto-approves ordinary tool calls but hands a sandbox
 *     ESCALATION — the one-shot widening that lets a file operation or command
 *     leave the workspace — back to the GUI answerer, because that decision is
 *     the user's.
 *   - The DEFAULT mode lives in the DSH settings service (namespace
 *     "approval-mode"), so it persists across restarts. Each session's own
 *     mode is a second value in the same namespace, keyed by session id; a
 *     session without one follows the default. The answerer resolves the mode
 *     per request from the requesting agent's session.
 *   - The client half reads/writes both through a small HTTP route
 *     (`GET/POST /approval-mode`) registered on the public webServer service.
 *     The settings RPC surface is deliberately NOT used: a compose-time
 *     control route keeps the mode read/write self-contained and avoids
 *     coupling to the settings RPC's write semantics.
 *   - On a mode change, the agents whose effective mode actually moved are
 *     notified via an injected message.
 *
 * The client half (lib/client.js) renders two surfaces over these values: the
 * session picker next to the permission selector, which edits the current
 * session, and this plugin's card on the settings page (设置 → 插件 → 插件配置),
 * which edits the default new sessions open with. Registering the namespace is
 * what makes that card eligible: the plugins tab pairs every SERVED settings
 * namespace with the browser half that claims its key. See doc/design.md for
 * the full design.
 */
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** Stable Cordis plugin name (also the bundle row id). */
export const name = "dsh-approval-mode";

/** Required services: settings (mode storage), webServer (control route). */
export const inject = ["settings", "webServer"];

/** Settings namespace holding the approval modes. */
export const NS = "approval-mode";

/** DSH's stock behaviour: every tool call that asks goes to the user. */
export const ASK = "ask";

/** Auto-approve every tool call, sandbox escalations included. */
export const BYPASS = "bypass";

/** Auto-approve every tool call except a sandbox escalation. */
export const BYPASS_EXCEPT_ESCALATION = "bypass-except-escalation";

/** Every approval mode this plugin can put a session in. */
export const MODES = [ASK, BYPASS_EXCEPT_ESCALATION, BYPASS];

/** Mode every unresolved read falls back to. */
export const DEFAULT_MODE = ASK;

/**
 * Schemastery schema for the namespace.
 *
 * `defaultMode` is the mode a session opens with and `sessions` maps a session
 * id to that session's own mode. `mode` is the single global value this plugin
 * wrote before the two were split; it stays readable so an existing
 * settings.yaml keeps its value across the upgrade, and is shadowed as soon as
 * a `defaultMode` is written.
 */
export const MODE_SCHEMA = z.object({
  mode: z.union(MODES),
  defaultMode: z.union(MODES),
  sessions: z.dict(z.union(MODES)).default({})
});

/** Control route path served by this plugin. */
export const ROUTE_PATH = "/approval-mode";

/**
 * The sandbox-escalation ask, as `@deepseek-ai/dsh-sandbox` spells it:
 * `approveEscalation()` requests its decision with the reason
 * `escalate sandbox to <mode>: <justification>`, from `dsh-tool-bash`,
 * `dsh-tool-pwsh` and `dsh-tool-fs` alike.
 *
 * An approval request carries agent, tool name, call id, reason and signal —
 * nothing that says what KIND of ask it is. This prefix is therefore the only
 * signal that separates a privilege escalation from an ordinary approval.
 */
export const ESCALATION_REASON = /^escalate sandbox to [^:]+:/;

/**
 * Whether a request is a sandbox escalation.
 * @param req - the pending approval request.
 * @returns true when the request widens the sandbox for one call.
 */
export function isEscalationRequest(req) {
  return typeof req?.reason === "string" && ESCALATION_REASON.test(req.reason);
}

/**
 * Resolve the default mode from a settings value.
 * @param value - resolved settings value for {@link NS}.
 * @returns one of {@link MODES}.
 */
export function defaultModeOf(value) {
  const stored = value?.defaultMode ?? value?.mode;
  return MODES.includes(stored) ? stored : DEFAULT_MODE;
}

/**
 * Resolve one session's effective mode: its own entry, else the default.
 * @param value - resolved settings value for {@link NS}.
 * @param sessionId - the session's id, when the request carries one.
 * @returns one of {@link MODES}.
 */
export function sessionModeOf(value, sessionId) {
  const stored = typeof sessionId === "string" ? value?.sessions?.[sessionId] : undefined;
  return MODES.includes(stored) ? stored : defaultModeOf(value);
}

/** Model-facing sentence for one mode, following the DSH UI language. */
function modeSentence(mode, en) {
  if (en) {
    switch (mode) {
      case BYPASS: return "bypass approval (every tool call is auto-approved, sandbox escalations included)";
      case BYPASS_EXCEPT_ESCALATION: return "bypass approval except escalations (tool calls are auto-approved; widening the sandbox outside the workspace still asks the user)";
      default: return "default approval (tool calls require a click to approve)";
    }
  }
  switch (mode) {
    case BYPASS: return "绕过审批（所有工具调用自动批准，含工作区外提权）";
    case BYPASS_EXCEPT_ESCALATION: return "绕过审批（提权除外）（工具调用自动批准，工作区外提权仍会询问用户）";
    default: return "默认审批（工具调用需要点击审批）";
  }
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
  // One line at mount: it is what tells a user (and a bug report) that the
  // plugin composed on their DSH build at all, and which default is in force.
  console.log(`[dsh-approval-mode] loaded: default mode = ${defaultModeOf(ctx.settings.get(NS))}`);

  /**
   * Front-of-chain approval answerer (prepend). DSH's GUI answerer
   * (dsh-host-apiproxy) always claims pending approvals and waits for a
   * client click; registering before it lets a bypass mode settle the decision
   * without ever broadcasting an approval/requested frame.
   *
   * The mode is the REQUESTING session's, so one window may bypass while
   * another still asks.
   */
  ctx.on("approval/request", async (req, next) => {
    try {
      const sessionId = req && req.agent && req.agent.session ? req.agent.session.id : undefined;
      const mode = sessionModeOf(ctx.settings.get(NS), sessionId);
      const tool = req && req.toolName ? req.toolName : "(unknown tool)";
      const at = sessionId ? ` @ ${sessionId}` : "";
      if (mode === BYPASS) {
        console.log(`[dsh-approval-mode] bypass: auto-approved ${tool}${at}`);
        return "allowed-once";
      }
      if (mode === BYPASS_EXCEPT_ESCALATION) {
        // A sandbox escalation is the user's call even under bypass: it is the
        // one approval that widens the fence rather than passing through it.
        if (isEscalationRequest(req)) {
          console.log(`[dsh-approval-mode] bypass (except escalations): handing ${tool}${at} to the user`);
          return next();
        }
        console.log(`[dsh-approval-mode] bypass (except escalations): auto-approved ${tool}${at}`);
        return "allowed-once";
      }
    } catch (err) {
      console.error("[dsh-approval-mode] answerer error:", err);
    }
    return next();
  }, true);

  /**
   * Control route. The ADDRESS says what is read or written — the default, or
   * one session's own mode — and the body carries only the value:
   *
   *   GET  /approval-mode                 -> the default mode
   *   GET  /approval-mode?session=<id>    -> that session's effective mode
   *   POST /approval-mode                 { mode } -> set the default
   *   POST /approval-mode?session=<id>    { mode } -> set that session's mode
   *
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
      let session = null;
      try {
        const addressed = new URL(req.url ?? ROUTE_PATH, "http://localhost").searchParams.get("session");
        session = addressed === null || addressed.length === 0 ? null : addressed;
      } catch {
        session = null;
      }
      if (req.method === "GET") {
        const value = ctx.settings.get(NS);
        writeJson(200, {
          ok: true,
          mode: session === null ? defaultModeOf(value) : sessionModeOf(value, session),
          defaultMode: defaultModeOf(value),
          ...session === null ? {} : { session }
        });
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
      const mode = parsed !== null && typeof parsed === "object" ? parsed.mode : undefined;
      if (!MODES.includes(mode)) {
        writeJson(400, { ok: false, error: "invalid-mode", mode });
        return;
      }
      const before = ctx.settings.get(NS);
      try {
        await ctx.settings.update(NS, session === null ? { defaultMode: mode } : { sessions: { [session]: mode } });
      } catch (err) {
        console.error("[dsh-approval-mode] settings update failed:", err);
        writeJson(500, { ok: false, error: "settings-update-failed" });
        return;
      }
      const after = ctx.settings.get(NS);
      writeJson(200, {
        ok: true,
        mode: session === null ? defaultModeOf(after) : sessionModeOf(after, session),
        defaultMode: defaultModeOf(after),
        changed: (session === null ? defaultModeOf(after) : sessionModeOf(after, session))
          !== (session === null ? defaultModeOf(before) : sessionModeOf(before, session)),
        ...session === null ? {} : { session }
      });
    }
  }), "dsh-approval-mode: control route");

  /**
   * Notify every agent whose session mode actually moved. A default change
   * reaches only the sessions that follow the default; a per-session change
   * reaches that session alone.
   */
  ctx.on("settings/updated", (ns, next, prev) => {
    if (ns !== NS) return;
    console.log(`[dsh-approval-mode] settings/updated: default mode = ${defaultModeOf(next)}`);
    const agents = ctx.get("agents");
    if (!agents || typeof agents.list !== "function") return;
    // 通知文案跟随 DSH 语言（locale settings preference；缺省回退中文）
    const locale = ctx.settings.get("locale");
    const en = !!(locale && locale.preference === "en");
    for (const agent of agents.list()) {
      try {
        if (!agent || typeof agent.inject !== "function") continue;
        const sessionId = agent.session ? agent.session.id : undefined;
        const mode = sessionModeOf(next, sessionId);
        if (mode === sessionModeOf(prev, sessionId)) continue;
        // Use createUserMessage so the message carries a stable identity (id)
        // and is frozen first — DSH 0.1.1-rc.2+ validates message identity at
        // the session seed/load boundary and a raw object would fail resume.
        agent.inject(createUserMessage({
          content: [{ type: "text", text: en
            ? `The approval mode of this session was switched by the user to "${modeSentence(mode, true)}".`
            : `本会话的审批模式已由用户切换为「${modeSentence(mode, false)}」。` }],
          source: { kind: "plugin", plugin: "approval-mode" }
        }));
      } catch (err) {
        console.error("[dsh-approval-mode] agent notify error:", err);
      }
    }
  });
}
