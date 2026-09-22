#!/usr/bin/env node
/**
 * check-host.mjs — offline contract check for index.js.
 *
 * The Host half imports `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-llm`,
 * which this repository deliberately does not install: a plugin must resolve
 * them from the DSH shared layer, never from a private copy. This script
 * registers module hooks that serve both specifiers from in-process stubs, so
 * the real `index.js` is loaded and exercised with no node_modules and no
 * running DSH. What that buys is coverage of the parts whose failure is
 * silent in production:
 *
 *   1. the mode vocabulary is the three values the client half offers;
 *   2. a sandbox escalation is recognised from the reason `dsh-sandbox`
 *      actually sends — and nothing else is mistaken for one;
 *   3. the answerer's outcome per mode: ask delegates, both bypass modes
 *      auto-approve, and ONLY `bypass-except-escalation` hands an escalation
 *      back to the user;
 *   4. the mode is resolved PER SESSION, with the default as the fallback;
 *   5. the single global `mode` written by 0.1.2 and earlier still decides the
 *      default after the upgrade (settings.yaml migration);
 *   6. the control route addresses a session and the default separately — the
 *      address says which is read or written — and refuses a non-loopback
 *      caller, an unknown mode and a malformed body.
 *
 * It deliberately does not import index.js as a module without the stubs, needs
 * no browser and no dependencies — `npm run check` is its only caller.
 */
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCHEMA_STUB = `
function node(kind) {
  const self = (value) => (value === undefined ? self.fallback() : self.resolve(value));
  self.kind = kind;
  self.resolve = (value) => value;
  self.fallback = () => undefined;
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
    if (STUBS.has(specifier)) return { url: `dsh-stub:${specifier}`, shortCircuit: true };
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
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL ${label}`);
  }
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The settings service as index.js uses it: register/get/update over a raw section. */
function deepMerge(under, over) {
  if (under === undefined) return over;
  if (over === null || typeof over !== "object" || Array.isArray(over)) return over;
  if (typeof under !== "object" || under === null || Array.isArray(under)) return over;
  const merged = { ...under };
  for (const [key, value] of Object.entries(over)) merged[key] = deepMerge(merged[key], value);
  return merged;
}

/**
 * Boot one Host half over a fake Cordis context. `section` is the raw user
 * layer a real settings.yaml would hold.
 */
function boot(initialSection = {}) {
  const registrations = [];
  const routes = [];
  const listeners = new Map();
  /** Every `ctx.on` call, so the prepend flag itself is observable. */
  const subscriptions = [];
  const agents = [];
  let section = initialSection;
  const settings = {
    register(ns, schema, options) {
      registrations.push({ ns, schema, options });
      return null;
    },
    get(ns) {
      if (ns !== host.NS) return undefined;
      return host.MODE_SCHEMA(section);
    },
    async update(ns, patch) {
      if (ns !== host.NS) throw new Error(`unexpected namespace ${ns}`);
      const prev = host.MODE_SCHEMA(section);
      section = deepMerge(section, patch);
      const next = host.MODE_SCHEMA(section);
      for (const listener of listeners.get("settings/updated") ?? []) listener(ns, next, prev, "update");
      await tick();
    }
  };
  const ctx = {
    settings,
    effect(fn) {
      const off = fn();
      return typeof off === "function" ? off : () => {};
    },
    on(event, handler, prepend) {
      subscriptions.push({ event, prepend: prepend === true });
      const list = listeners.get(event) ?? [];
      if (prepend) list.unshift(handler);
      else list.push(handler);
      listeners.set(event, list);
      return () => {};
    },
    get(name) {
      return name === "agents" ? { list: () => agents } : undefined;
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      }
    }
  };
  host.apply(ctx);
  return {
    section: () => section,
    registrations,
    routes,
    listeners,
    agents,
    settings,
    subscriptions,

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

/** A request as `approveEscalation()` sends it. */
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

// 1: the mode vocabulary.
{
  check(deepEqual(host.MODES, ["ask", "bypass-except-escalation", "bypass"]), "the mode vocabulary is ask / bypass-except-escalation / bypass");
  check(host.DEFAULT_MODE === "ask", "the unresolved fallback is ask");
  const ui = boot();
  check(
    ui.registrations.some((entry) => entry.ns === host.NS && entry.options?.applies === "live"),
    "the settings namespace is registered as live"
  );
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

// 3: the answerer's outcome per mode.
{
  const ui = boot({ defaultMode: "ask" });
  check(ui.answererPrepended(), "the answerer is prepended, ahead of the GUI answerer");
  check((await ui.ask(ordinary("s"))).delegated, "ask delegates an ordinary request to the GUI answerer");
  check((await ui.ask(escalation("s"))).delegated, "ask delegates an escalation to the GUI answerer");
}
{
  const ui = boot({ defaultMode: "bypass" });
  check((await ui.ask(ordinary("s"))).outcome === "allowed-once", "bypass auto-approves an ordinary request");
  check((await ui.ask(escalation("s"))).outcome === "allowed-once", "bypass still auto-approves an escalation (the mode's documented meaning)");
}
{
  const ui = boot({ defaultMode: "bypass-except-escalation" });
  check((await ui.ask(ordinary("s"))).outcome === "allowed-once", "bypass-except-escalation auto-approves an ordinary request");
  const handed = await ui.ask(escalation("s"));
  check(handed.delegated && handed.outcome === "unavailable", "bypass-except-escalation hands an escalation to the user instead of approving it");
}

// 4: the mode is per session, with the default as the fallback.
{
  const ui = boot({ defaultMode: "ask", sessions: { one: "bypass" } });
  check((await ui.ask(ordinary("one"))).outcome === "allowed-once", "a session with its own mode uses it");
  check((await ui.ask(ordinary("two"))).delegated, "a session without one follows the default");
}

// 5: the pre-split single value still decides the default.
{
  check(host.defaultModeOf(host.MODE_SCHEMA({ mode: "bypass" })) === "bypass", "a legacy mode value is still read as the default");
  check(host.defaultModeOf(host.MODE_SCHEMA({ mode: "bypass", defaultMode: "ask" })) === "ask", "a written defaultMode shadows the legacy value");
  check(host.defaultModeOf(host.MODE_SCHEMA({})) === "ask", "an empty section falls back to ask");
  check(host.defaultModeOf({ mode: "nonsense" }) === "ask", "an out-of-vocabulary value falls back to ask");
}

// 6: the control route.
{
  const ui = boot({ defaultMode: "bypass", sessions: { one: "ask" } });
  const plain = await ui.request();
  check(plain.status === 200 && plain.body.mode === "bypass", "GET without a session answers the default mode");
  check(plain.body.defaultMode === "bypass", "GET carries the default alongside it");
  const scoped = await ui.request({ url: `${host.ROUTE_PATH}?session=one` });
  check(scoped.status === 200 && scoped.body.mode === "ask", "GET with a session answers that session's mode");
  const inherited = await ui.request({ url: `${host.ROUTE_PATH}?session=two` });
  check(inherited.body.mode === "bypass", "GET with a session without its own mode answers the default");

  const setSession = await ui.request({ method: "POST", url: `${host.ROUTE_PATH}?session=one`, body: JSON.stringify({ mode: "bypass-except-escalation" }) });
  check(setSession.status === 200 && setSession.body.mode === "bypass-except-escalation", "POST with a session writes that session's mode");
  check((await ui.ask(ordinary("one"))).outcome === "allowed-once", "the written session mode is what the answerer then applies");
  check((await ui.ask(escalation("one"))).delegated, "the escalation carve-out follows the session, not the default");
  check((await ui.ask(escalation("two"))).outcome === "allowed-once", "another session keeps the default's own meaning");
  const defaultAfter = await ui.request();
  check(defaultAfter.body.mode === "bypass", "writing a session's mode leaves the default alone");

  const setDefault = await ui.request({ method: "POST", body: JSON.stringify({ mode: "ask" }) });
  check(setDefault.status === 200 && setDefault.body.defaultMode === "ask" && setDefault.body.changed === true, "POST without a session writes the default");
  check((await ui.request({ url: `${host.ROUTE_PATH}?session=one` })).body.mode === "bypass-except-escalation", "writing the default leaves a session's own mode alone");
  const emptySession = await ui.request({ url: `${host.ROUTE_PATH}?session=` });
  check(emptySession.body.mode === "ask" && emptySession.body.session === undefined, "an empty session parameter addresses the default");

  const nonsensical = await ui.request({ method: "POST", body: JSON.stringify({ mode: "nonsense" }) });
  check(nonsensical.status === 400 && nonsensical.body.error === "invalid-mode", "an unknown mode is refused");
  const empty = await ui.request({ method: "POST", body: JSON.stringify({}) });
  check(empty.status === 400 && empty.body.error === "invalid-mode", "a write naming no mode is refused");
  const sessionless = await ui.request({ method: "POST", url: `${host.ROUTE_PATH}?session=two`, body: JSON.stringify({ defaultMode: "ask" }) });
  check(sessionless.status === 400, "a body key other than mode is refused");
  const malformed = await ui.request({ method: "POST", body: "{" });
  check(malformed.status === 400 && malformed.body.error === "bad-json", "a malformed body is refused");
  const wrongMethod = await ui.request({ method: "DELETE" });
  check(wrongMethod.status === 405, "an unsupported method is refused");
  const foreign = await ui.request({ host: "example.com" });
  check(foreign.status === 403, "a non-loopback caller is refused");
}

// 7: only the agents whose effective mode moved are notified.
{
  const ui = boot({ defaultMode: "ask" });
  const injected = [];
  ui.agents.push({ session: { id: "one" }, inject: (message) => injected.push({ id: "one", message }) });
  ui.agents.push({ session: { id: "two" }, inject: (message) => injected.push({ id: "two", message }) });
  await ui.settings.update(host.NS, { sessions: { one: "bypass" } });
  check(injected.length === 1 && injected[0].id === "one", "a per-session change notifies that session only");
  check(injected[0].message?.content?.[0]?.text?.includes("绕过审批"), "the notice states the mode in the user's language");
  injected.length = 0;
  await ui.settings.update(host.NS, { defaultMode: "bypass" });
  check(injected.length === 1 && injected[0].id === "two", "a default change notifies the sessions that follow the default");
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} host check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nall host checks passed");
