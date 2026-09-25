#!/usr/bin/env node
/**
 * check-host.mjs — offline contract check for index.js.
 *
 * The Host half imports "node:fs"/"node:os"/"node:path" plus
 * "@deepseek-ai/schemastery" and "@deepseek-ai/dsh-llm", which this repository
 * deliberately does not install: a plugin must resolve those from the DSH
 * shared layer, never from a private copy. This script registers module hooks
 * that serve both specifiers from in-process stubs, points DSH_HOME at a fresh
 * temporary directory, and exercises the real "index.js" with no node_modules
 * and no running DSH. What that buys is coverage of the parts whose failure is
 * silent in production — and of the two settings generations the plugin has to
 * bridge:
 *
 *   1. the mode vocabulary is the three values the client half offers, and the
 *      plugin config declares the default mode as a live (volatile) field;
 *   2. a sandbox escalation is recognised from the reason "dsh-sandbox"
 *      actually sends — and nothing else is mistaken for one;
 *   3. the answerer's outcome per mode: ask delegates, both bypass modes
 *      auto-approve, and ONLY "bypass-except-escalation" hands an escalation
 *      back to the user;
 *   4. the mode is resolved PER SESSION, with the default as the fallback, and
 *      the per-session map survives a restart (it is written to
 *      $DSH_HOME/approval-mode/sessions.json);
 *   5. DSH <= 0.1.6: the legacy settings namespace is still registered and read,
 *      the pre-split single "mode" still decides the default, and a "sessions"
 *      map left there is carried over into the store once;
 *   6. DSH 0.1.7+: a settings service WITHOUT "register" (config forms over
 *      profile patches) mounts and serves the same contract, the default comes
 *      from the live config reference, and a default write goes through the
 *      settings service by the plugin's own loader entry id;
 *   7. a host with no settings service at all still gets the answerer, the
 *      route and the store;
 *   8. the control route addresses a session and the default separately — the
 *      address says which is read or written — and refuses a non-loopback
 *      caller, an unknown mode, a malformed body and a prototype key;
 *   9. only the agents whose effective mode moved are notified, exactly once
 *      per change, no matter whether this plugin, the legacy document or the
 *      loader's volatile-update reported it;
 *  10. a malformed session store degrades to empty instead of failing the
 *      plugin, and a route write that cannot be persisted answers 500.
 *
 * It deliberately does not import index.js as a module without the stubs, needs
 * no browser and no dependencies — "npm run check" is its only caller.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every plugin instance in this process reads its store from here. */
const HOME = mkdtempSync(path.join(tmpdir(), "dsh-approval-mode-check-"));
process.env.DSH_HOME = HOME;

const SCHEMA_STUB = `
function node(kind) {
  const self = (value) => (value === undefined ? self.fallback() : self.resolve(value));
  self.kind = kind;
  self.resolve = (value) => value;
  self.fallback = () => undefined;
  self.volatile = () => {
    self.isVolatile = true;
    return self;
  };
  self.default = (value) => {
    const base = self.resolve;
    self.resolve = (input) => (input === undefined ? value : base(input));
    self.fallback = () => value;
    return self;
  };
  self.toJSON = () => ({ type: kind });
  return self;
}
function union(list) {
  const self = node("union");
  self.resolve = (value) => {
    if (!list.includes(value)) throw new Error("unexpected value " + String(value));
    return value;
  };
  return self;
}
function dict(inner) {
  const self = node("dict");
  self.resolve = (value) => {
    const input = value === undefined || value === null ? {} : value;
    const out = {};
    for (const [key, entry] of Object.entries(input)) out[key] = inner(entry);
    return out;
  };
  return self;
}
function object(shape) {
  const self = node("object");
  self.shape = shape;
  self.resolve = (value) => {
    const input = value === undefined || value === null ? {} : value;
    const out = {};
    for (const [key, child] of Object.entries(shape)) {
      const resolved = child(input[key]);
      if (resolved !== undefined) out[key] = resolved;
    }
    return out;
  };
  return self;
}
export default { object, union, dict };
`;

const LLM_STUB = `
export function createUserMessage(message) {
  return { ...message, id: "stub-message-id" };
}
`;

const STUBS = new Map([
  ["@deepseek-ai/schemastery", SCHEMA_STUB],
  ["@deepseek-ai/dsh-llm", LLM_STUB]
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (STUBS.has(specifier)) return { url: "dsh-stub:" + specifier, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith("dsh-stub:")) return nextLoad(url, context);
    return { format: "module", source: STUBS.get(url.slice("dsh-stub:".length)), shortCircuit: true };
  }
});

const host = await import("../index.js");

// ---------------------------------------------------------------------------

const failures = [];
function check(condition, label) {
  if (condition) {
    console.log("  ok   " + label);
  } else {
    failures.push(label);
    console.error("  FAIL " + label);
  }
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A live config reference, as the loader hands a .volatile() field to apply(). */
function liveRef(initial) {
  const state = { value: initial };
  return {
    state,
    get: () => state.value,
    set: (next) => {
      state.value = next;
    }
  };
}

/** Deep-merge one settings write into a raw legacy section. */
function deepMerge(under, over) {
  if (under === undefined) return over;
  if (over === null || typeof over !== "object" || Array.isArray(over)) return over;
  if (typeof under !== "object" || under === null || Array.isArray(under)) return over;
  const merged = { ...under };
  for (const [key, value] of Object.entries(over)) merged[key] = deepMerge(merged[key], value);
  return merged;
}

/** A fresh directory for one plugin instance's home. */
function freshHome() {
  return mkdtempSync(path.join(HOME, "boot-"));
}

/** The session store path of one home, for assertions about what landed. */
const storePathOf = (home) => path.join(home, host.SESSION_STORE_DIR, host.SESSION_STORE_FILE);

/**
 * Boot one Host half over a fake Cordis context.
 *
 * @param options.generation - "legacy" (settings with register/get/update),
 *   "forms" (0.1.7+: settings with describe/update and a live config reference),
 *   or "none" (no settings service at all).
 * @param options.section - the raw user layer a legacy settings document holds.
 * @param options.config - the resolved plugin config (a live reference for the
 *   default, or a plain value).
 * @param options.home - reuse a home (to assert persistence across a restart).
 * @param options.localePreference - the legacy locale namespace value.
 * @param options.localeEntry - the locale plugin entry's config, for the notice language.
 * @param options.breakStore - sabotage the store before this boot reads it.
 * @param options.breakStoreValue - the bytes written by that sabotage.
 */
function boot(options = {}) {
  const generation = options.generation ?? "legacy";
  const home = options.home ?? freshHome();
  const registrations = [];
  const routes = [];
  const listeners = new Map();
  const subscriptions = [];
  const agents = [];
  const configUpdates = [];
  let section = options.section ?? {};
  const live = options.config ?? (generation === "forms" ? liveRef("ask") : undefined);

  const settings = generation === "none" ? undefined : generation === "legacy"
    ? {
        register(ns, schema, opts) {
          registrations.push({ ns, schema, options: opts });
          return null;
        },
        get(ns) {
          if (ns === "locale") return options.localePreference === undefined ? undefined : { preference: options.localePreference };
          if (ns !== host.NS) return undefined;
          return host.MODE_SCHEMA(section);
        },
        async update(ns, patch) {
          if (ns !== host.NS) throw new Error("unexpected namespace " + ns);
          const prev = host.MODE_SCHEMA(section);
          section = deepMerge(section, patch);
          const next = host.MODE_SCHEMA(section);
          for (const listener of listeners.get("settings/updated") ?? []) listener(ns, next, prev, "update");
          await tick();
        }
      }
    : {
        describe() {
          return [{ ns: host.name }];
        },
        async update(ns, patch) {
          configUpdates.push({ ns, patch });
          if (live !== undefined && live.set !== undefined && patch[host.DEFAULT_MODE_FIELD] !== undefined) {
            live.set(patch[host.DEFAULT_MODE_FIELD]);
          }
          // The real service commits through the loader, which emits this on
          // the owning fiber's own context right after the reference moves.
          for (const listener of listeners.get("loader/volatile-update") ?? []) listener([[host.DEFAULT_MODE_FIELD]]);
          await tick();
        }
      };

  /** The loader entry whose fiber is this plugin's own, plus the locale entry. */
  const configEditor = {
    configuration() {
      const rows = [{ entry: { fiber: { uid: 1 }, options: { id: host.name } }, override: {}, inherited: {} }];
      if (options.localeEntry !== undefined) {
        rows.push({ entry: { fiber: { uid: 2 }, options: { id: "locale" } }, override: options.localeEntry, inherited: {} });
      }
      return rows;
    }
  };

  const ctx = {
    fiber: { uid: 1 },
    inject(services, callback) {
      if (services.includes("settings") && settings !== undefined) callback({ settings, effect: ctx.effect });
    },
    effect(fn) {
      const off = fn();
      return typeof off === "function" ? off : () => {};
    },
    on(event, handler, prepend) {
      subscriptions.push({ event, prepend: prepend === true });
      const list = listeners.get(event) ?? [];
      if (prepend === true) list.unshift(handler);
      else list.push(handler);
      listeners.set(event, list);
      return () => {};
    },
    get(name) {
      if (name === "agents") return { list: () => agents };
      if (name === "dshHomePath") return (...segments) => path.join(home, ...segments);
      if (name === "configEditor") return configEditor;
      if (name === "settings") return settings;
      return undefined;
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      }
    },
    // Real Cordis exposes an injected service as a property as well as through get().
    ...(settings === undefined ? {} : { settings })
  };

  if (options.breakStore === true) {
    mkdirSync(path.dirname(storePathOf(home)), { recursive: true });
    writeFileSync(storePathOf(home), options.breakStoreValue ?? "{ not json", "utf8");
  }

  host.apply(ctx, live === undefined ? undefined : { [host.DEFAULT_MODE_FIELD]: live });

  return {
    home,
    section: () => section,
    registrations,
    routes,
    listeners,
    agents,
    settings,
    subscriptions,
    configUpdates,
    /** Emit one host event, as the harness would. */
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },

    /** Ask the approval waterfall; returns the outcome and whether next() ran. */
    async ask(request) {
      let delegated = false;
      const handler = (listeners.get("approval/request") ?? [])[0];
      if (handler === undefined) throw new Error("no approval/request answerer registered");
      const outcome = await handler(request, async () => {
        delegated = true;
        return "unavailable";
      });
      return { outcome, delegated };
    },
    /** Whether the answerer was registered ahead of the GUI answerer. */
    answererPrepended: () => subscriptions.some((entry) => entry.event === "approval/request" && entry.prepend === true),
    /** Drive the control route; returns the HTTP status and parsed body. */
    async request({ method = "GET", url = host.ROUTE_PATH, host: hostHeader = "127.0.0.1:43120", body = "" } = {}) {
      const route = routes[0];
      if (route === undefined) throw new Error("no control route registered");
      const handlers = {};
      let flushed = false;
      const flush = () => {
        if (body.length > 0) for (const cb of handlers.data ?? []) cb(Buffer.from(body));
        for (const cb of handlers.end ?? []) cb();
      };
      const req = {
        method,
        url,
        headers: { host: hostHeader },
        destroy() {},
        on(event, callback) {
          (handlers[event] ??= []).push(callback);
          if (!flushed) {
            flushed = true;
            queueMicrotask(flush);
          }
          return req;
        }
      };
      const res = {
        status: 0,
        writeHead(status) {
          res.status = status;
        },
        end(text) {
          res.body = text ?? "";
        }
      };
      await route.handler(req, res);
      return { status: res.status, body: res.body.length > 0 ? JSON.parse(res.body) : undefined };
    }
  };
}

/** A request as approveEscalation() sends it. */
const escalation = (sessionId) => ({
  agent: { session: { id: sessionId } },
  toolName: "write",
  reason: "escalate sandbox to danger-full-access: the report must land outside the workspace"
});
/** A request as any other answerer sends it. */
const ordinary = (sessionId, reason) => ({
  agent: { session: { id: sessionId } },
  toolName: "read",
  ...(reason === undefined ? {} : { reason })
});

// ---------------------------------------------------------------------------

console.log("dsh-approval-mode: host contract");

// 1: the mode vocabulary and the plugin config.
{
  check(deepEqual(host.MODES, ["ask", "bypass-except-escalation", "bypass"]), "the mode vocabulary is ask / bypass-except-escalation / bypass");
  check(host.DEFAULT_MODE === "ask", "the unresolved fallback is ask");
  check(host.inject.includes("webServer") && !host.inject.includes("settings"), "only webServer is a required service (settings is optional)");
  const field = host.Config?.shape?.[host.DEFAULT_MODE_FIELD];
  check(field !== undefined, "the plugin declares a Config carrying the default mode");
  check(field?.isVolatile === true, "the default mode is a live (volatile) config field");
  check(field?.fallback() === "ask", "the config field defaults to ask");
}

// 2: what counts as an escalation.
{
  check(host.isEscalationRequest(escalation("s")), "the reason dsh-sandbox sends is recognised as an escalation");
  check(host.isEscalationRequest({ reason: "escalate sandbox to workspace-write: need one file" }), "every escalation target is recognised, not just danger-full-access");
  check(!host.isEscalationRequest(ordinary("s", "the user asked for this")), "an ordinary approval reason is not an escalation");
  check(!host.isEscalationRequest(ordinary("s")), "a request without a reason is not an escalation");
  check(!host.isEscalationRequest(undefined), "a missing request is not an escalation");
  check(!host.isEscalationRequest({ reason: "please escalate sandbox to danger-full-access: x" }), "only the leading escalation prefix counts");
}

// 3: the legacy generation (DSH <= 0.1.6) still mounts and answers.
{
  const ui = boot({ generation: "legacy", section: { defaultMode: "ask" } });
  check(ui.registrations.some((entry) => entry.ns === host.NS && entry.options?.applies === "live"), "the legacy settings namespace is registered as live");
  check(ui.answererPrepended(), "the answerer is prepended, ahead of the GUI answerer");
  check((await ui.ask(ordinary("s"))).delegated, "ask delegates an ordinary request to the GUI answerer");
  check((await ui.ask(escalation("s"))).delegated, "ask delegates an escalation to the GUI answerer");
}
{
  const ui = boot({ generation: "legacy", section: { defaultMode: "bypass" } });
  check((await ui.ask(ordinary("s"))).outcome === "allowed-once", "bypass auto-approves an ordinary request");
  check((await ui.ask(escalation("s"))).outcome === "allowed-once", "bypass still auto-approves an escalation (the mode's documented meaning)");
}
{
  const ui = boot({ generation: "legacy", section: { defaultMode: "bypass-except-escalation" } });
  check((await ui.ask(ordinary("s"))).outcome === "allowed-once", "bypass-except-escalation auto-approves an ordinary request");
  const handed = await ui.ask(escalation("s"));
  check(handed.delegated && handed.outcome === "unavailable", "bypass-except-escalation hands an escalation to the user instead of approving it");
}

// 4: the 0.1.7+ generation — the regression this check exists for.
{
  let threw = null;
  let ui = null;
  try {
    ui = boot({ generation: "forms", config: liveRef("bypass") });
  } catch (err) {
    threw = err;
  }
  check(threw === null, "a settings service WITHOUT register (0.1.7+) mounts the plugin instead of throwing");
  check(ui !== null && ui.registrations.length === 0, "the legacy namespace is not registered on that generation");
  check(ui !== null && (await ui.ask(ordinary("s"))).outcome === "allowed-once", "the live config reference decides the default mode");
  const effective = await ui.request();
  check(effective.status === 200 && effective.body.defaultMode === "bypass", "the route reports the live config default");
}

// 5: the live reference moves from the HOST side (the settings form's write).
{
  const live = liveRef("ask");
  const ui = boot({ generation: "forms", config: live });
  const injected = [];
  ui.agents.push({ session: { id: "one" }, inject: (message) => injected.push({ id: "one", message }) });
  check((await ui.ask(ordinary("one"))).delegated, "the session starts on the default");
  live.set("bypass");
  ui.emit("loader/volatile-update", [[host.DEFAULT_MODE_FIELD]]);
  check(injected.length === 1 && injected[0].id === "one", "a host-side config change notifies the sessions that follow the default");
  check((await ui.ask(escalation("one"))).outcome === "allowed-once", "the moved reference is what the answerer applies");
  ui.emit("loader/volatile-update", [[host.DEFAULT_MODE_FIELD]]);
  check(injected.length === 1, "an event that reports no change notifies nobody");
  ui.emit("loader/volatile-update", [["unrelatedField"]]);
  ui.emit("settings/updated", "some-other-namespace", {}, {});
  check(injected.length === 1, "other namespaces and config paths are ignored");
}

// 6: the mode is per session, with the default as the fallback.
{
  const ui = boot({ generation: "forms", config: liveRef("ask") });
  await ui.request({ method: "POST", url: host.ROUTE_PATH + "?session=one", body: JSON.stringify({ mode: "bypass" }) });
  check((await ui.ask(ordinary("one"))).outcome === "allowed-once", "a session with its own mode uses it");
  check((await ui.ask(ordinary("two"))).delegated, "a session without one follows the default");
}

// 7: the session map survives a restart (the store is a file, not the document).
{
  const home = freshHome();
  const first = boot({ generation: "forms", config: liveRef("ask"), home });
  await first.request({ method: "POST", url: host.ROUTE_PATH + "?session=one", body: JSON.stringify({ mode: "bypass" }) });
  check(readFileSync(storePathOf(home), "utf8").includes("\"one\": \"bypass\""), "the session write lands in the store file");
  const restarted = boot({ generation: "forms", config: liveRef("ask"), home });
  const read = await restarted.request({ url: host.ROUTE_PATH + "?session=one" });
  check(read.body.mode === "bypass", "a restarted plugin instance reads the stored session mode");
  check((await restarted.ask(ordinary("one"))).outcome === "allowed-once", "the restarted answerer applies it");
}

// 8: a store that cannot be understood degrades to empty, and repairs on write.
{
  const home = freshHome();
  const ui = boot({ generation: "forms", config: liveRef("bypass"), home, breakStore: true });
  const read = await ui.request({ url: host.ROUTE_PATH + "?session=one" });
  check(read.status === 200 && read.body.mode === "bypass", "a malformed store falls back to the default instead of failing");
  const written = await ui.request({ method: "POST", url: host.ROUTE_PATH + "?session=one", body: JSON.stringify({ mode: "ask" }) });
  check(written.status === 200 && written.body.mode === "ask", "a write replaces the malformed store");
  check(readFileSync(storePathOf(home), "utf8").includes("\"one\": \"ask\""), "the replacement is a valid store file");
  check(host.parseSessionStore("{ nope") === null, "parseSessionStore rejects a non-JSON document");
  check(host.parseSessionStore("null") === null, "parseSessionStore rejects a JSON null document");
  check(deepEqual(host.parseSessionStore("{\"sessions\":{\"a\":\"bypass\",\"__proto__\":\"bypass\",\"b\":\"nope\"}}"), { a: "bypass" }), "parseSessionStore drops reserved keys and out-of-vocabulary modes");
  check(deepEqual(host.parseSessionStore("{\"a\":\"ask\"}"), { a: "ask" }), "parseSessionStore also reads a bare mode map");
}

// 9: the legacy namespace still decides the default, migrations included.
{
  check(host.defaultModeOf(host.MODE_SCHEMA({ mode: "bypass" })) === "bypass", "a legacy mode value is still read as the default");
  check(host.defaultModeOf(host.MODE_SCHEMA({ mode: "bypass", defaultMode: "ask" })) === "ask", "a written defaultMode shadows the legacy value");
  check(host.defaultModeOf(host.MODE_SCHEMA({})) === "ask", "an empty section falls back to ask");
  check(host.defaultModeOf({ mode: "nonsense" }) === "ask", "an out-of-vocabulary value falls back to ask");
  const ui = boot({ generation: "legacy", section: { mode: "bypass" } });
  check((await ui.ask(ordinary("s"))).outcome === "allowed-once", "the legacy document's value is what the answerer applies");
}

// 10: the pre-0.1.7 sessions map is carried into the store exactly once.
{
  const home = freshHome();
  const ui = boot({ generation: "legacy", section: { defaultMode: "ask", sessions: { one: "bypass" } }, home });
  check((await ui.ask(ordinary("one"))).outcome === "allowed-once", "a session mode left in the legacy document is used");
  check(readFileSync(storePathOf(home), "utf8").includes("\"one\": \"bypass\""), "and is carried into the store file");
  const again = boot({ generation: "legacy", section: { defaultMode: "ask" }, home });
  check((await again.ask(ordinary("one"))).outcome === "allowed-once", "the carried map outlives the legacy document");
}

// 11: a host with no settings service at all.
{
  const ui = boot({ generation: "none", config: liveRef("bypass-except-escalation") });
  check(ui.routes.length === 1, "the control route is registered with no settings service");
  check((await ui.ask(ordinary("s"))).outcome === "allowed-once", "the answerer works with no settings service");
  const read = await ui.request();
  check(read.status === 200 && read.body.defaultMode === "bypass-except-escalation", "the route answers from the config value");
  const session = await ui.request({ method: "POST", url: host.ROUTE_PATH + "?session=one", body: JSON.stringify({ mode: "bypass" }) });
  check(session.status === 200, "a session write still works");
  const write = await ui.request({ method: "POST", body: JSON.stringify({ mode: "ask" }) });
  check(write.status === 500 && write.body.error === "settings-unavailable", "a default write says the settings service is unavailable");
}

// 12: the control route's address semantics and refusals.
{
  const ui = boot({ generation: "forms", config: liveRef("bypass") });
  await ui.request({ method: "POST", url: host.ROUTE_PATH + "?session=one", body: JSON.stringify({ mode: "ask" }) });
  const plain = await ui.request();
  check(plain.status === 200 && plain.body.mode === "bypass", "GET without a session answers the default mode");
  check(plain.body.defaultMode === "bypass", "GET carries the default alongside it");
  const scoped = await ui.request({ url: host.ROUTE_PATH + "?session=one" });
  check(scoped.status === 200 && scoped.body.mode === "ask", "GET with a session answers that session's mode");
  const inherited = await ui.request({ url: host.ROUTE_PATH + "?session=two" });
  check(inherited.body.mode === "bypass", "GET with a session without its own mode answers the default");

  const setSession = await ui.request({ method: "POST", url: host.ROUTE_PATH + "?session=one", body: JSON.stringify({ mode: "bypass-except-escalation" }) });
  check(setSession.status === 200 && setSession.body.mode === "bypass-except-escalation", "POST with a session writes that session's mode");
  check((await ui.ask(ordinary("one"))).outcome === "allowed-once", "the written session mode is what the answerer then applies");
  check((await ui.ask(escalation("one"))).delegated, "the escalation carve-out follows the session, not the default");
  check((await ui.ask(escalation("two"))).outcome === "allowed-once", "another session keeps the default's own meaning");
  const defaultAfter = await ui.request();
  check(defaultAfter.body.mode === "bypass", "writing a session's mode leaves the default alone");

  const setDefault = await ui.request({ method: "POST", body: JSON.stringify({ mode: "ask" }) });
  check(setDefault.status === 200 && setDefault.body.defaultMode === "ask" && setDefault.body.changed === true, "POST without a session writes the default");
  check(ui.configUpdates.length === 1 && ui.configUpdates[0].ns === host.name, "the default write goes through the settings service by entry id");
  check(ui.configUpdates[0].patch[host.DEFAULT_MODE_FIELD] === "ask", "the write carries the config field, not a namespace key");
  check((await ui.request({ url: host.ROUTE_PATH + "?session=one" })).body.mode === "bypass-except-escalation", "writing the default leaves a session's own mode alone");
  const sameDefault = await ui.request({ method: "POST", body: JSON.stringify({ mode: "ask" }) });
  check(sameDefault.body.changed === false && ui.configUpdates.length === 1, "rewriting the same default is a no-op");
  check(ui.routes.length === 1, "the route is registered exactly once");
  const emptySession = await ui.request({ url: host.ROUTE_PATH + "?session=" });
  check(emptySession.body.mode === "ask" && emptySession.body.session === undefined, "an empty session parameter addresses the default");
  const poisoned = await ui.request({ url: host.ROUTE_PATH + "?session=__proto__" });
  check(poisoned.status === 400 && poisoned.body.error === "invalid-session", "an address that would rewrite a prototype is refused");

  const nonsensical = await ui.request({ method: "POST", body: JSON.stringify({ mode: "nonsense" }) });
  check(nonsensical.status === 400 && nonsensical.body.error === "invalid-mode", "an unknown mode is refused");
  const empty = await ui.request({ method: "POST", body: JSON.stringify({}) });
  check(empty.status === 400 && empty.body.error === "invalid-mode", "a write naming no mode is refused");
  const otherKey = await ui.request({ method: "POST", url: host.ROUTE_PATH + "?session=two", body: JSON.stringify({ defaultMode: "ask" }) });
  check(otherKey.status === 400, "a body key other than mode is refused");
  const malformed = await ui.request({ method: "POST", body: "{" });
  check(malformed.status === 400 && malformed.body.error === "bad-json", "a malformed body is refused");
  const wrongMethod = await ui.request({ method: "DELETE" });
  check(wrongMethod.status === 405, "an unsupported method is refused");
  const foreign = await ui.request({ host: "example.com" });
  check(foreign.status === 403, "a non-loopback caller is refused");
}

// 13: writes through the legacy generation also land, once, in the document.
{
  const ui = boot({ generation: "legacy", section: { defaultMode: "ask" } });
  const write = await ui.request({ method: "POST", body: JSON.stringify({ mode: "bypass" }) });
  check(write.status === 200 && write.body.defaultMode === "bypass", "the default write is reported on the legacy generation");
  check(ui.section().defaultMode === "bypass", "and reaches the legacy document");
  const read = await ui.request();
  check(read.body.defaultMode === "bypass", "the legacy document is what a later read answers");
}

// 14: only the agents whose effective mode moved are notified, exactly once.
{
  const ui = boot({ generation: "legacy", section: { defaultMode: "ask" } });
  const injected = [];
  ui.agents.push({ session: { id: "one" }, inject: (message) => injected.push({ id: "one", message }) });
  ui.agents.push({ session: { id: "two" }, inject: (message) => injected.push({ id: "two", message }) });
  await ui.request({ method: "POST", url: host.ROUTE_PATH + "?session=one", body: JSON.stringify({ mode: "bypass" }) });
  check(injected.length === 1 && injected[0].id === "one", "a per-session change notifies that session only");
  check(injected[0].message?.content?.[0]?.text?.includes("绕过审批"), "the notice states the mode in the user's language");
  injected.length = 0;
  await ui.request({ method: "POST", body: JSON.stringify({ mode: "bypass" }) });
  check(injected.length === 1 && injected[0].id === "two", "a default change notifies the sessions that follow the default, once");
  injected.length = 0;
  await ui.settings.update(host.NS, { defaultMode: "ask" });
  check(injected.length === 1 && injected[0].id === "two", "a change written straight into the legacy document is observed once");
}
{
  const ui = boot({ generation: "forms", config: liveRef("ask"), localeEntry: { preference: "en" } });
  const injected = [];
  ui.agents.push({ session: { id: "one" }, inject: (message) => injected.push({ id: "one", message }) });
  await ui.request({ method: "POST", body: JSON.stringify({ mode: "bypass" }) });
  check(injected.length === 1, "the route's own default write notifies exactly once (the loader event is not a second notice)");
  check(injected[0].message?.content?.[0]?.text?.includes("bypass approval"), "the notice follows the locale entry's preference on the new generation");
}

// 15: the store's home resolution.
{
  const viaService = host.sessionStorePath({ get: (name) => (name === "dshHomePath" ? (...segments) => path.join("/tmp", "home", ...segments) : undefined) });
  check(viaService === path.join("/tmp", "home", host.SESSION_STORE_DIR, host.SESSION_STORE_FILE), "the dshHomePath service is preferred when the host composes it");
  const viaEnv = host.sessionStorePath({});
  check(viaEnv === path.join(HOME, host.SESSION_STORE_DIR, host.SESSION_STORE_FILE), "the store falls back to DSH_HOME");
}

// ---------------------------------------------------------------------------

rmSync(HOME, { recursive: true, force: true });

if (failures.length > 0) {
  console.error("\n" + failures.length + " host check(s) failed:");
  for (const failure of failures) console.error("  - " + failure);
  process.exit(1);
}
console.log("\nall host checks passed");