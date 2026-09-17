#!/usr/bin/env node
/**
 * check-client.mjs — offline contract check for lib/client.js.
 *
 * The client half is a `window.__ModuleLoader__` bundle: it cannot be imported
 * as a module, nothing type-checks it, and its failures are visible only in a
 * browser console. This script loads it with stubbed globals (window, document,
 * react, fetch) and asserts what would otherwise be discovered by opening the
 * GUI:
 *
 *   1. the composer picker is registered into conversation.input.left;
 *   2. the plugin-page card is registered into settings.plugin.item keyed by
 *      the settings namespace — what makes the plugins tab dispatch it;
 *   3. a host WITHOUT the settingsScope client service still gets the picker
 *      and no card (the graceful-degradation claim in the file header);
 *   4. the card renders both options, reflects the current mode, and writes the
 *      chosen one through the Host control route;
 *   5. every dictionary key the surfaces ask for exists in BOTH languages;
 *   6. a failed read leaves the mode UNKNOWN on both surfaces instead of
 *      presenting the schema default as the setting;
 *   7. a read that a later selection superseded never overwrites that selection;
 *   8. a failed write restores the last value the HOST confirmed — not the
 *      optimistic value of an overlapping selection.
 *
 * It deliberately does not import lib/client.js as a module, needs no browser
 * and needs no dependencies — `npm run check` is its only caller.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "lib", "client.js"), "utf8");

const NS = "approval-mode";
const ROUTE = "/approval-mode";
const SELECT_SLOT = "conversation.input.left";
const CARD_SLOT = "settings.plugin.item";

const failures = [];
function check(condition, label) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL ${label}`);
  }
}

/** Every dictionary key any surface asked for, asserted against both languages. */
const asked = [];
function translate(dictionaries) {
  return (key, params) => {
    asked.push(key);
    const zh = dictionaries?.[NS]?.zh ?? {};
    let text = zh[key] ?? key;
    if (params) {
      for (const name of Object.keys(params)) text = text.split(`{${name}}`).join(String(params[name]));
    }
    return text;
  };
}

/** Minimal element tree: enough to walk what a component returns. */
function createElement(type, props, ...children) {
  const flat = [];
  for (const child of children) {
    if (Array.isArray(child)) flat.push(...child.flat(Infinity));
    else if (child !== null && child !== undefined && child !== false) flat.push(child);
  }
  return { type, props: props ?? {}, children: flat };
}

function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  for (const child of node.children ?? []) collectText(child, out);
  return out;
}

function findBy(node, predicate, out = []) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) findBy(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) findBy(child, predicate, out);
  return out;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const okJson = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

/** A promise whose settlement the test decides. */
function deferred() {
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = (kind, value) => (kind === "reject" ? reject(value) : resolve(value));
  });
  return { promise, resolve: (value) => settle("resolve", value), reject: (error) => settle("reject", error) };
}

/**
 * Boot a fresh bundle instance (a new closure, so module-level state is clean).
 *
 * `stateQueue` pins successive `useState` calls of the component under test; an
 * `undefined` entry means "use the component's real initial value", which is
 * how a render reads the live store instead of a pinned snapshot. Effects run
 * during the render call — a stub simplification that is what makes the store's
 * lazy load observable offline.
 */
function boot({ withSettingsScope, stateQueue = [], fetchImpl }) {
  let registration;
  const window = { __ModuleLoader__: { load: (value) => { registration = value; } } };
  const document = {
    head: { appendChild() {} },
    createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: "" }),
    addEventListener() {},
    removeEventListener() {}
  };
  // The bundle is a script, not a module: evaluate it with its globals bound.
  new Function("window", "document", "fetch", "console", source)(window, document, fetchImpl, console);
  if (registration === undefined) throw new Error("bundle did not call window.__ModuleLoader__.load");

  const dictionaries = {};
  const registrations = [];
  let queue = stateQueue.slice();
  const react = {
    useState(initial) {
      const pinned = queue.length > 0 ? queue.shift() : undefined;
      return [pinned !== undefined ? pinned : (typeof initial === "function" ? initial() : initial), () => {}];
    },
    useEffect(fn) {
      if (typeof fn === "function") fn();
    },
    createElement
  };
  const ctx = {
    effect(fn) {
      const off = fn();
      return typeof off === "function" ? off : () => {};
    },
    on() {
      return () => {};
    },
    locale: {
      register(ns, dicts) {
        dictionaries[ns] = dicts;
        return () => {};
      }
    },
    slots: {
      inject(slot, register) {
        register();
      },
      register(options, component) {
        registrations.push({ slot: options.name, options, component });
        return () => {};
      }
    },
    inject(services, callback) {
      if (withSettingsScope && services.includes("settingsScope")) callback(ctx);
    }
  };

  if (registration.id !== "dsh-approval-mode") throw new Error(`unexpected bundle id ${String(registration.id)}`);
  const module = registration.factory((id) => {
    if (id === "react") return react;
    throw new Error(`unexpected require(${JSON.stringify(id)})`);
  });
  module.apply(ctx);

  const surface = (slot) => registrations.find((entry) => entry.slot === slot);
  return {
    module,
    registrations,
    dictionaries,
    /** Replace the pinned state queue used by the next render. */
    setQueue(values) {
      queue = (values ?? []).slice();
    },
    /** Render a surface; `undefined` entries read the component's real state. */
    render(slot, values) {
      queue = (values ?? []).slice();
      const entry = surface(slot);
      if (entry === undefined) throw new Error(`no registration for ${slot}`);
      const props = { t: translate(dictionaries) };
      if (slot === SELECT_SLOT) props.useProjection = () => null;
      return entry.component(props);
    }
  };
}

/** The trigger's visible label, i.e. what the user reads as the current mode. */
function toolbarLabel(tree) {
  const trigger = findBy(tree, (node) =>
    typeof node.props?.className === "string" &&
    node.props.className.split(" ").includes("dsh-approval-mode-trigger"))[0];
  if (trigger === undefined) throw new Error("toolbar trigger not found");
  const label = findBy(trigger, (node) => node.props?.className === "dsh-approval-mode-triggerLabel")[0];
  return { text: collectText(label).join(""), trigger };
}

function menuitem(tree, text) {
  return findBy(tree, (node) => node.props?.role === "menuitem")
    .find((node) => collectText(node).join("").includes(text));
}

// ---------------------------------------------------------------------------

console.log("dsh-approval-mode: client bundle contract");

// 1 + 2: a complete host registers both surfaces.
{
  const ui = boot({ withSettingsScope: true, fetchImpl: () => okJson({ ok: true, mode: "ask" }) });
  const picker = ui.registrations.find((entry) => entry.slot === SELECT_SLOT);
  const card = ui.registrations.find((entry) => entry.slot === CARD_SLOT);
  check(ui.module.name === "dsh-approval-mode", "bundle exports the plugin name");
  check(Array.isArray(ui.module.inject) && ui.module.inject.includes("slots") && ui.module.inject.includes("locale"), "bundle injects slots + locale");
  check(picker !== undefined && picker.options.id === "approval-mode-select", "picker registered in conversation.input.left");
  check(picker !== undefined && picker.options.locale === NS, "picker binds the approval-mode dictionary");
  check(card !== undefined && card.options.key === NS, "plugin card registered into settings.plugin.item keyed by the settings namespace");
  check(card !== undefined && card.options.locale === NS, "plugin card binds the approval-mode dictionary");
}

// 3: a host that does not compose the settings client keeps the picker and loses only the card.
{
  const ui = boot({ withSettingsScope: false, fetchImpl: () => Promise.reject(new Error("this check must not fetch")) });
  check(ui.registrations.some((entry) => entry.slot === SELECT_SLOT), "without settingsScope the picker is still registered");
  check(!ui.registrations.some((entry) => entry.slot === CARD_SLOT), "without settingsScope no plugin card is registered");
}

// 4: render the expanded card against a bypass-mode host and switch it.
{
  const requests = [];
  const fetchImpl = (url, init) => {
    requests.push({ url, method: init?.method ?? "GET", body: init?.body });
    return init?.method === "POST" ? okJson({ ok: true }) : okJson({ ok: true, mode: "bypass" });
  };
  const ui = boot({ withSettingsScope: true, fetchImpl });
  const snapshot = { mode: "bypass", ready: true, known: true, saving: false, failed: false };
  const tree = ui.render(CARD_SLOT, [snapshot, true]);

  const texts = collectText(tree).join(" | ");
  check(tree.type === "li", "card renders a list item (the tab's container is a <ul>)");
  check(texts.includes(ui.dictionaries[NS].zh["card.title"]), "card header shows the plugin title");
  check(texts.includes(ui.dictionaries[NS].zh["item.ask"]) && texts.includes(ui.dictionaries[NS].zh["item.bypass"]), "card shows both mode options");
  check(texts.includes(ui.dictionaries[NS].zh["card.hint.bypass"]), "card explains the currently selected mode");

  const radios = findBy(tree, (node) => node.props?.role === "radio");
  check(radios.length === 2, "card renders exactly two radio options");
  const asks = radios.find((node) => collectText(node).join("").includes(ui.dictionaries[NS].zh["item.ask"]));
  const bypasses = radios.find((node) => collectText(node).join("").includes(ui.dictionaries[NS].zh["item.bypass"]));
  check(bypasses?.props?.["aria-checked"] === true, "the current mode is the checked option");
  check(asks?.props?.["aria-checked"] === false, "the other option is not checked");

  asks?.props?.onClick?.();
  await tick();
  const post = requests.find((entry) => entry.method === "POST");
  check(post !== undefined && post.url === ROUTE, "choosing a mode POSTs to the Host control route");
  check(post !== undefined && post.body === JSON.stringify({ mode: "ask" }), "the POST body carries the chosen mode");
}

// 6: a failed read leaves the value UNKNOWN — never the schema default.
{
  const ui = boot({ withSettingsScope: true, fetchImpl: () => Promise.reject(new Error("host unreachable")) });
  ui.render(SELECT_SLOT, [undefined]); // mount: starts the (failing) read
  await tick();
  const card = ui.render(CARD_SLOT, [undefined, true]);
  const radios = findBy(card, (node) => node.props?.role === "radio");
  check(radios.length === 2 && radios.every((node) => node.props["aria-checked"] === false), "after a failed read the card marks no option");
  check(collectText(card).join(" ").includes(ui.dictionaries[NS].zh["card.error"]), "after a failed read the card shows the error line");

  const label = toolbarLabel(ui.render(SELECT_SLOT, [undefined]));
  check(label.text === ui.dictionaries[NS].zh["mode.unknown"], "after a failed read the toolbar says the mode is unknown");
  check(label.trigger.props.disabled === true, "after a failed read the toolbar is not switchable");
}

// 7: a read overtaken by a selection must not publish its stale value.
{
  const reads = [];
  const ui = boot({
    withSettingsScope: true,
    fetchImpl: (url, init) => {
      if (init?.method === "POST") return okJson({ ok: true });
      const d = deferred();
      reads.push(d);
      return d.promise;
    }
  });
  const menu = ui.render(SELECT_SLOT, [undefined, true]); // mounts the store; the GET stays pending
  menuitem(menu, ui.dictionaries[NS].zh["item.bypass"])?.props?.onClick?.();
  await tick();
  check(toolbarLabel(ui.render(SELECT_SLOT, [undefined]))?.text === ui.dictionaries[NS].zh["mode.bypass"], "the selection is applied optimistically");

  reads[0].resolve({ ok: true, json: () => Promise.resolve({ ok: true, mode: "ask" }) });
  await tick();
  check(
    toolbarLabel(ui.render(SELECT_SLOT, [undefined])).text === ui.dictionaries[NS].zh["mode.bypass"],
    "a read superseded by a selection does not overwrite it (stale GET is dropped)"
  );
}

// 8a: with nothing confirmed, a failed write restores UNKNOWN, not the sibling's optimistic value.
{
  const posts = [];
  const ui = boot({
    withSettingsScope: true,
    fetchImpl: (url, init) => {
      if (init?.method !== "POST") return okJson({ ok: true, mode: "ask" });
      const d = deferred();
      posts.push({ body: init.body, d });
      return d.promise;
    }
  });
  const menu = ui.render(SELECT_SLOT, [undefined, true]);
  await tick(); // the read confirms "ask"
  menuitem(menu, ui.dictionaries[NS].zh["item.bypass"])?.props?.onClick?.(); // optimistic "bypass", never confirmed
  menuitem(menu, ui.dictionaries[NS].zh["item.ask"])?.props?.onClick?.(); // newer selection
  posts[0].d.reject(new Error("offline"));
  posts[1].d.reject(new Error("offline"));
  await tick();
  check(
    toolbarLabel(ui.render(SELECT_SLOT, [undefined])).text === ui.dictionaries[NS].zh["mode.ask"],
    "a failed write restores the value the Host confirmed, not the optimistic sibling"
  );
}

// 8b: a superseded write that SUCCEEDED is the restore point for a later failure.
{
  const posts = [];
  const ui = boot({
    withSettingsScope: true,
    fetchImpl: (url, init) => {
      if (init?.method !== "POST") return okJson({ ok: true, mode: "ask" });
      const d = deferred();
      posts.push({ body: init.body, d });
      return d.promise;
    }
  });
  const menu = ui.render(SELECT_SLOT, [undefined, true]);
  await tick(); // the read confirms "ask"
  menuitem(menu, ui.dictionaries[NS].zh["item.bypass"])?.props?.onClick?.(); // first write: will succeed
  menuitem(menu, ui.dictionaries[NS].zh["item.ask"])?.props?.onClick?.(); // second write: supersedes, will fail
  posts[0].d.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  posts[1].d.resolve({ ok: true, json: () => Promise.resolve({ ok: false }) });
  await tick();
  check(
    toolbarLabel(ui.render(SELECT_SLOT, [undefined])).text === ui.dictionaries[NS].zh["mode.bypass"],
    "a superseded write the Host applied becomes the restore point"
  );
}

// 8c: out-of-order responses — only the NEWEST success may set the restore point.
{
  const posts = [];
  const ui = boot({
    withSettingsScope: true,
    fetchImpl: (url, init) => {
      if (init?.method !== "POST") return okJson({ ok: true, mode: "ask" });
      const d = deferred();
      posts.push({ body: init.body, d });
      return d.promise;
    }
  });
  const menu = ui.render(SELECT_SLOT, [undefined, true]);
  await tick(); // the read confirms "ask"
  menuitem(menu, ui.dictionaries[NS].zh["item.bypass"])?.props?.onClick?.();
  menuitem(menu, ui.dictionaries[NS].zh["item.ask"])?.props?.onClick?.();
  posts[1].d.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }); // newest succeeds first
  posts[0].d.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }); // older success arrives late
  await tick();
  menuitem(menu, ui.dictionaries[NS].zh["item.bypass"])?.props?.onClick?.(); // a third write that fails
  posts[2].d.reject(new Error("offline"));
  await tick();
  check(
    toolbarLabel(ui.render(SELECT_SLOT, [undefined])).text === ui.dictionaries[NS].zh["mode.ask"],
    "a late response from a superseded write does not regress the confirmed value"
  );
}

// 5: every key a surface asked for exists in both languages.
{
  const ui = boot({ withSettingsScope: true, fetchImpl: () => okJson({ ok: true, mode: "ask" }) });
  ui.render(CARD_SLOT, [undefined, true]);
  ui.render(SELECT_SLOT, [undefined, true]);
  const zh = ui.dictionaries[NS]?.zh ?? {};
  const en = ui.dictionaries[NS]?.en ?? {};
  const missing = asked.filter((key) => zh[key] === undefined || en[key] === undefined);
  check(asked.length > 0 && missing.length === 0, `every key asked for exists in zh and en${missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""}`);
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} client bundle check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nall client bundle checks passed");
