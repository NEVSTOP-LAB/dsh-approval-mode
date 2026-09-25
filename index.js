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
 *   - The DEFAULT mode is the plugin's own `Config.defaultMode`. DSH 0.1.7+
 *     projects a plugin's `Config` into its settings page and hands the plugin
 *     a LIVE reference for every `.volatile()` field, so the default is read
 *     with `config.defaultMode.get()` and the settings form writes it without
 *     remounting this plugin. DSH <= 0.1.6 has no such projection: there the
 *     same value lives in the legacy settings namespace (`approval-mode`),
 *     which this plugin still registers and reads when that service — i.e. one
 *     with `register` — is present.
 *   - Each SESSION's own mode is a second value, keyed by session id and kept
 *     in a small JSON file under the DSH home (`<home>/approval-mode/
 *     sessions.json`). It deliberately does NOT live in the settings service:
 *     the namespace that held it before 0.1.7 is gone, and on 0.1.7+ that
 *     service only edits a plugin's Config — per-session runtime state keyed by
 *     an open-ended id set does not belong in the profile patch. The file's
 *     first load carries over the `sessions` map an older install left in the
 *     namespace.
 *   - The client half reads/writes both through the same small HTTP route
 *     (`GET/POST /approval-mode`) registered on the public webServer service.
 *     The route keeps the settings RPC surface out of the plugin: a
 *     compose-time control route keeps the mode read/write self-contained and
 *     survives both settings generations unchanged.
 *   - On a mode change, the agents whose effective mode actually moved are
 *     notified via an injected message.
 *
 * The client half (lib/client.js) renders two surfaces over these values: the
 * session picker next to the permission selector, which edits the current
 * session, and (on DSH <= 0.1.6) the plugin's card on the settings page
 * (设置 → 插件 → 插件配置), which edits the default. On 0.1.7+ the settings page
 * draws that card itself, from `Config.defaultMode`; the browser half adds
 * only the picker. See doc/design.md for the full design.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** Stable Cordis plugin name (also the bundle row id). */
export const name = "dsh-approval-mode";

/**
 * Required services: only the public `webServer` the control route is
 * registered on.
 *
 * `settings` is deliberately NOT required. DSH 0.1.7 replaced the namespace
 * settings service (`register`/`get`/`update` over one document) with config
 * forms over profile patches, so requiring it would either fail to mount or
 * mount a service this plugin cannot use — the exact breakage an older
 * revision of this file hit on 0.1.7. It is consumed optionally through
 * `ctx.inject` instead: whichever generation is present is used, and a host
 * with neither still gets the answerer, the route and the session store.
 */
export const inject = ["webServer"];

/** Settings namespace holding the approval modes (DSH <= 0.1.6). */
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

/** Field name of the default mode inside the plugin's own configuration. */
export const DEFAULT_MODE_FIELD = "defaultMode";

/**
 * Legacy namespace schema (DSH <= 0.1.6).
 *
 * `defaultMode` is the mode a session opens with and `sessions` maps a session
 * id to that session's own mode. `mode` is the single global value this plugin
 * wrote before the two were split; it stays readable so an existing
 * settings.yaml keeps its value, and is shadowed as soon as a `defaultMode` is
 * written. `sessions` is still declared so an upgrade leaves the old document
 * valid, and is read once to seed {@link SESSION_STORE_FILE}; nothing writes it
 * any more.
 */
export const MODE_SCHEMA = z.object({
  mode: z.union(MODES),
  defaultMode: z.union(MODES),
  sessions: z.dict(z.union(MODES)).default({})
});

/** The default mode as a plain config field, before it is made live. */
const defaultModeField = z.union(MODES).default(DEFAULT_MODE);

/**
 * The plugin's own configuration (DSH 0.1.7+).
 *
 * `defaultMode` is marked `.volatile()` wherever schemastery supports it: the
 * loader then keeps this plugin mounted and updates the reference in place when
 * the profile patch changes (`loader/volatile-update`), which is what lets the
 * settings page write the default and this half observe it. On an older
 * schemastery the modifier is absent and the field stays an ordinary value; the
 * legacy namespace below is the live source there either way.
 */
export const Config = z.object({
  [DEFAULT_MODE_FIELD]: typeof defaultModeField.volatile === "function" ? defaultModeField.volatile() : defaultModeField
});

/** Control route path served by this plugin. */
export const ROUTE_PATH = "/approval-mode";

/**
 * Directory under the DSH home that holds this plugin's own state.
 *
 * Plugin-owned, next to the harness's own `storages`/`sessions` directories
 * rather than inside them, so nothing here can be mistaken for a harness
 * document.
 */
export const SESSION_STORE_DIR = "approval-mode";

/** File inside {@link SESSION_STORE_DIR} holding the per-session modes. */
export const SESSION_STORE_FILE = "sessions.json";

/** Format version of the session store document. */
export const SESSION_STORE_VERSION = 1;

/**
 * Session addresses this route and the store refuse. A session id becomes the
 * KEY of an entry in the session map, and these three are the keys whose
 * assignment rewrites a prototype instead of creating an entry — the write
 * would be silently dropped rather than stored, so the address is refused
 * instead of accepted and ignored.
 */
export const RESERVED_SESSION_KEYS = ["__proto__", "constructor", "prototype"];

/**
 * Whether an address names a session this route may write.
 * @param value - the raw `session` query parameter.
 * @returns true when the value can key a session entry.
 */
export function isSessionAddress(value) {
  return typeof value === "string" && value.length > 0 && !RESERVED_SESSION_KEYS.includes(value);
}

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
 * Resolve the default mode from a legacy settings value.
 * @param value - resolved settings value for {@link NS}.
 * @returns one of {@link MODES}.
 */
export function defaultModeOf(value) {
  const stored = value?.defaultMode ?? value?.mode;
  return MODES.includes(stored) ? stored : DEFAULT_MODE;
}

/**
 * Resolve one session's effective mode: its own entry, else the default.
 * @param value - a mode document ({ defaultMode, sessions }).
 * @param sessionId - the session's id, when the request carries one.
 * @returns one of {@link MODES}.
 */
export function sessionModeOf(value, sessionId) {
  const stored = typeof sessionId === "string" ? value?.sessions?.[sessionId] : undefined;
  return MODES.includes(stored) ? stored : defaultModeOf(value);
}

/**
 * Keep only the entries of a session map that this plugin can store and use.
 * @param value - any parsed `sessions` value, from the file or the legacy namespace.
 * @returns a fresh map with reserved keys and out-of-vocabulary modes dropped.
 */
export function sanitizeSessions(value) {
  const out = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, mode] of Object.entries(value)) {
    if (isSessionAddress(key) && MODES.includes(mode)) out[key] = mode;
  }
  return out;
}

/**
 * Parse a {@link SESSION_STORE_FILE} document.
 * @param text - raw file contents.
 * @returns the session map, or null when the document is not a JSON object.
 */
export function parseSessionStore(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  // Accept both the versioned envelope and a bare { sessionId: mode } map, so a
  // hand-written file (and the legacy namespace value) read the same way.
  const sessions = parsed.sessions !== null && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions)
    ? parsed.sessions
    : parsed;
  return sanitizeSessions(sessions);
}

/**
 * Absolute path of this plugin's session store.
 *
 * The app-boot `dshHomePath` service is the harness's own resolver and is used
 * when composed; otherwise the documented precedence is repeated here
 * (`$DSH_HOME`, then `~/.dsh`) so the store never lands somewhere the harness
 * would not look.
 * @param ctx - plugin context.
 * @returns the absolute path of the store file.
 */
export function sessionStorePath(ctx) {
  const homePath = ctx !== undefined && ctx !== null && typeof ctx.get === "function" ? ctx.get("dshHomePath") : undefined;
  if (typeof homePath === "function") {
    try {
      return homePath(SESSION_STORE_DIR, SESSION_STORE_FILE);
    } catch {
      // A host whose resolver rejects these segments falls through to the
      // documented default rather than failing the whole plugin.
    }
  }
  const configured = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
  const home = configured.length > 0 ? configured : join(homedir(), ".dsh");
  return join(home, SESSION_STORE_DIR, SESSION_STORE_FILE);
}

/**
 * The profile entry id of the plugin instance behind `ctx`.
 *
 * DSH 0.1.7 keys settings documents by the LOADER ENTRY id, which is the id the
 * bundle patch inserts. It is matched through the fiber — the entry whose fiber
 * is this plugin's own — rather than assumed from the package name, so a patch
 * that inserts the row under a different id still addresses itself.
 * @param ctx - plugin context.
 * @returns the entry id, or null when the address cannot be established.
 */
export function ownEntryId(ctx) {
  try {
    const editor = typeof ctx.get === "function" ? ctx.get("configEditor") : undefined;
    if (editor === undefined || editor === null || typeof editor.configuration !== "function") return null;
    const uid = ctx.fiber === undefined || ctx.fiber === null ? undefined : ctx.fiber.uid;
    if (uid === undefined) return null;
    for (const row of editor.configuration()) {
      const owner = row === undefined || row === null ? undefined : row.entry?.fiber;
      if (owner === undefined || owner === null || owner.uid !== uid) continue;
      const id = row.entry.options === undefined ? undefined : row.entry.options.id;
      return typeof id === "string" ? id : null;
    }
  } catch (err) {
    console.error("[dsh-approval-mode] could not address the plugin's profile entry:", err);
  }
  return null;
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

/**
 * Whether the DSH UI language is English.
 *
 * The locale preference moved with the rest of the settings: DSH <= 0.1.6
 * serves it as the `locale` settings namespace, 0.1.7+ as the `locale` plugin
 * entry's own `preference` config field. Both are read before the Chinese
 * default this plugin has always used.
 * @param ctx - plugin context.
 * @returns true when English was explicitly selected.
 */
function prefersEnglish(ctx) {
  try {
    const settings = typeof ctx.get === "function" ? ctx.get("settings") : undefined;
    if (settings !== undefined && settings !== null && typeof settings.get === "function") {
      const locale = settings.get("locale");
      if (locale !== null && typeof locale === "object" && typeof locale.preference === "string") return locale.preference === "en";
    }
  } catch {
    // A settings service that does not serve this namespace is not an error.
  }
  try {
    const editor = typeof ctx.get === "function" ? ctx.get("configEditor") : undefined;
    if (editor === undefined || editor === null || typeof editor.configuration !== "function") return false;
    for (const row of editor.configuration()) {
      if (row === undefined || row === null || row.entry?.options?.id !== LOCALE_ENTRY_ID) continue;
      const stored = row.override?.preference ?? row.inherited?.preference;
      if (typeof stored === "string") return stored === "en";
    }
  } catch {
    // An unreadable configuration is not an error for a notice's language.
  }
  return false;
}

/** Loader entry id of the locale plugin, whose config carries the UI language. */
const LOCALE_ENTRY_ID = "locale";

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

/**
 * The per-session mode map, backed by {@link sessionStoreFile}.
 *
 * Reads are synchronous and lazily load the file once, because the answerer
 * resolves a mode inside a synchronous waterfall and must never await I/O
 * there. The file is small (one short entry per session that ever switched) and
 * is written atomically — temporary file plus rename — so a crash mid-write
 * cannot leave a half-written map behind.
 *
 * Every failure degrades rather than throws: an unreadable or malformed store
 * starts empty (and says so in the log), and a failed write leaves the previous
 * value in memory so the route can honestly answer that nothing was stored.
 * @param ctx - plugin context, for the home path.
 * @param legacySeed - reads the pre-0.1.7 `sessions` map, once, when no store exists yet.
 * @returns the store's read/write face.
 */
function createSessionModes(ctx, legacySeed) {
  let path = null;
  let loaded = false;
  let modes = {};

  function storePath() {
    if (path === null) path = sessionStorePath(ctx);
    return path;
  }

  function persist() {
    const target = storePath();
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify({ version: SESSION_STORE_VERSION, sessions: modes }, null, 2)}\n`, "utf8");
      renameSync(temporary, target);
      return true;
    } catch (err) {
      console.error("[dsh-approval-mode] writing the session store failed:", err);
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary file may never have been created; nothing to clean up.
      }
      return false;
    }
  }

  function load() {
    if (loaded) return;
    loaded = true;
    const target = storePath();
    let text = null;
    try {
      text = readFileSync(target, "utf8");
    } catch (err) {
      if (err === null || typeof err !== "object" || err.code !== "ENOENT") {
        console.error("[dsh-approval-mode] reading the session store failed:", err);
        return;
      }
    }
    if (text !== null) {
      const parsed = parseSessionStore(text);
      if (parsed === null) {
        console.error(`[dsh-approval-mode] session store is not a mode map, starting empty: ${target}`);
        return;
      }
      modes = parsed;
      return;
    }
    // First run with no store of our own: an install that predates DSH 0.1.7
    // kept the same map in the settings namespace, so carry it over once.
    const carried = sanitizeSessions(legacySeed());
    if (Object.keys(carried).length === 0) return;
    modes = carried;
    persist();
  }

  return {
    /** One session's own mode, or undefined when it follows the default. */
    get(sessionId) {
      load();
      return typeof sessionId === "string" ? modes[sessionId] : undefined;
    },
    /** A detached copy of the whole map (for snapshots and the route). */
    entries() {
      load();
      return { ...modes };
    },
    /** Store one session's mode; false when it could not be persisted. */
    set(sessionId, mode) {
      load();
      if (modes[sessionId] === mode) return true;
      const previous = modes[sessionId];
      modes[sessionId] = mode;
      if (persist()) return true;
      if (previous === undefined) delete modes[sessionId];
      else modes[sessionId] = previous;
      return false;
    }
  };
}

export function apply(ctx, config) {
  const initial = config !== null && typeof config === "object" ? config : {};
  /**
   * The live default (DSH 0.1.7+). A `.volatile()` field arrives as a
   * reference with `get()`; an ordinary value means the harness has no such
   * projection and the legacy namespace is the live source instead.
   */
  const liveDefault = initial[DEFAULT_MODE_FIELD] !== null && typeof initial[DEFAULT_MODE_FIELD] === "object" && typeof initial[DEFAULT_MODE_FIELD].get === "function"
    ? initial[DEFAULT_MODE_FIELD]
    : null;
  /** A config value that arrived as plain data (no volatile projection). */
  const declaredDefault = MODES.includes(initial[DEFAULT_MODE_FIELD]) ? initial[DEFAULT_MODE_FIELD] : undefined;

  /** The settings service of DSH <= 0.1.6 (namespace document). */
  let legacySettings = null;
  /** The settings service of DSH 0.1.7+ (config forms over profile patches). */
  let configForms = null;

  ctx.inject(["settings"], (sctx) => {
    const service = sctx === undefined || sctx === null ? undefined : sctx.settings;
    if (service === undefined || service === null) return;
    if (typeof service.register === "function" && typeof service.get === "function") {
      // DSH <= 0.1.6: one namespace per plugin, one durable settings document.
      // Keeping the registration is what lets an older browser half still show
      // its plugin card; the value written here is the default.
      try {
        service.register(NS, MODE_SCHEMA, { applies: "live" });
        legacySettings = service;
      } catch (err) {
        console.error("[dsh-approval-mode] registering the legacy settings namespace failed:", err);
      }
      return;
    }
    if (typeof service.update === "function" && typeof service.describe === "function") {
      // DSH 0.1.7+: the same service name, a completely different contract.
      // Only its write face is used; the value itself is read from the live
      // config reference above.
      configForms = service;
    }
  });

  /** The session map; created before anything can read it. */
  const sessionModes = createSessionModes(ctx, () => {
    if (legacySettings === null) return undefined;
    try {
      return legacySettings.get(NS)?.sessions;
    } catch (err) {
      console.error("[dsh-approval-mode] reading the legacy sessions map failed:", err);
      return undefined;
    }
  });

  /**
   * The default mode in force: an explicit legacy value first (that is where an
   * upgrade to 0.1.7+ left the user's choice, and where a <= 0.1.6 host still
   * writes it), then the live config reference, then a plain config value, then
   * the fail-closed default.
   */
  function readDefault() {
    if (legacySettings !== null) {
      try {
        const stored = legacySettings.get(NS);
        const explicit = stored?.defaultMode ?? stored?.mode;
        if (MODES.includes(explicit)) return explicit;
      } catch (err) {
        console.error("[dsh-approval-mode] reading the legacy settings namespace failed:", err);
      }
    }
    if (liveDefault !== null) {
      const value = liveDefault.get();
      return MODES.includes(value) ? value : DEFAULT_MODE;
    }
    return declaredDefault ?? DEFAULT_MODE;
  }

  /**
   * Persist the default through whichever settings generation is present.
   * @param mode - the mode to store.
   * @returns the outcome, for the route's status code.
   */
  async function writeDefault(mode) {
    if (legacySettings !== null) {
      await legacySettings.update(NS, { [DEFAULT_MODE_FIELD]: mode });
      return { ok: true };
    }
    if (configForms === null) return { ok: false, error: "settings-unavailable" };
    const entryId = ownEntryId(ctx);
    if (entryId === null) return { ok: false, error: "settings-unavailable" };
    await configForms.update(entryId, { [DEFAULT_MODE_FIELD]: mode });
    return { ok: true };
  }

  /** One snapshot of both stored values. */
  function snapshot() {
    return { defaultMode: readDefault(), sessions: sessionModes.entries() };
  }

  /**
   * Notify every agent whose EFFECTIVE mode moved between two snapshots. A
   * default change reaches only the sessions that follow the default; a
   * per-session change reaches that session alone.
   */
  function notify(before, after) {
    const agents = ctx.get("agents");
    if (!agents || typeof agents.list !== "function") return;
    const en = prefersEnglish(ctx);
    for (const agent of agents.list()) {
      try {
        if (!agent || typeof agent.inject !== "function") continue;
        const sessionId = agent.session ? agent.session.id : undefined;
        const mode = sessionModeOf(after, sessionId);
        if (mode === sessionModeOf(before, sessionId)) continue;
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
  }

  /**
   * The default this half last acted on or observed, so a change is announced
   * exactly once no matter which path reported it: this plugin's own write, the
   * legacy namespace's `settings/updated` (<= 0.1.6), or the loader's
   * `loader/volatile-update` (0.1.7+, the settings form's write).
   */
  let observedDefault = null;

  /** Re-read the default and announce a change that came from outside. */
  function observeDefault() {
    const current = readDefault();
    const previous = observedDefault === null ? current : observedDefault;
    observedDefault = current;
    if (previous === current) return;
    const sessions = sessionModes.entries();
    notify({ defaultMode: previous, sessions }, { defaultMode: current, sessions });
  }

  // One line at mount: it is what tells a user (and a bug report) that the
  // plugin composed on their DSH build at all, and which default is in force.
  observedDefault = readDefault();
  console.log(`[dsh-approval-mode] loaded: default mode = ${observedDefault}`);

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
      const stored = sessionModes.get(sessionId);
      // Mirrors sessionModeOf({ defaultMode, sessions }, sessionId) without
      // copying the whole map on every request; the store holds valid modes only.
      const mode = MODES.includes(stored) ? stored : readDefault();
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
   * The default may also move without this plugin writing it: on 0.1.7+ the
   * settings page edits the profile patch and the loader commits the new value
   * into the live reference this half holds; on <= 0.1.6 an edited settings
   * document reaches the namespace. Both are observed rather than polled.
   */
  ctx.on("settings/updated", (ns) => {
    if (ns !== NS) return;
    observeDefault();
  });
  ctx.on("loader/volatile-update", (paths) => {
    if (!Array.isArray(paths)) return;
    if (!paths.some((path) => Array.isArray(path) && path[0] === DEFAULT_MODE_FIELD)) return;
    observeDefault();
  });

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
        // An absent or empty parameter addresses the default; anything else
        // must be an address this route can actually key an entry with.
        if (addressed !== null && addressed.length > 0) {
          if (!isSessionAddress(addressed)) {
            writeJson(400, { ok: false, error: "invalid-session" });
            return;
          }
          session = addressed;
        }
      } catch {
        session = null;
      }
      if (req.method === "GET") {
        const value = snapshot();
        writeJson(200, {
          ok: true,
          mode: session === null ? value.defaultMode : sessionModeOf(value, session),
          defaultMode: value.defaultMode,
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
      const before = snapshot();
      if (session !== null) {
        if (!sessionModes.set(session, mode)) {
          writeJson(500, { ok: false, error: "store-write-failed" });
          return;
        }
        const after = snapshot();
        notify(before, after);
        writeJson(200, {
          ok: true,
          mode: sessionModeOf(after, session),
          defaultMode: after.defaultMode,
          changed: sessionModeOf(before, session) !== sessionModeOf(after, session),
          session
        });
        return;
      }
      if (before.defaultMode === mode) {
        writeJson(200, { ok: true, mode, defaultMode: mode, changed: false });
        return;
      }
      // Claim the new value BEFORE writing: the host reports its own write back
      // through the events observed above (the old namespace's settings/updated,
      // the loader's loader/volatile-update), and those must not announce the
      // same change a second time.
      const announced = observedDefault;
      observedDefault = mode;
      try {
        const result = await writeDefault(mode);
        if (!result.ok) {
          observedDefault = announced;
          writeJson(500, { ok: false, error: result.error });
          return;
        }
      } catch (err) {
        observedDefault = announced;
        console.error("[dsh-approval-mode] settings update failed:", err);
        writeJson(500, { ok: false, error: "settings-update-failed" });
        return;
      }
      const after = snapshot();
      notify(before, after);
      writeJson(200, { ok: true, mode, defaultMode: after.defaultMode, changed: true });
    }
  }), "dsh-approval-mode: control route");
}