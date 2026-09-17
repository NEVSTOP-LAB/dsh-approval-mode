#!/usr/bin/env node
/**
 * check-client.mjs — offline contract check for lib/client.js.
 *
 * The client half is a `window.__ModuleLoader__` bundle: it cannot be imported
 * as a module, nothing type-checks it, and its failures are visible only in a
 * browser console. This script loads it with stubbed globals (window, document,
 * react, fetch) and asserts the parts that would otherwise be discovered by
 * opening the GUI:
 *
 *   1. the composer picker is registered into conversation.input.left;
 *   2. the plugin-page card is registered into settings.plugin.item keyed by
 *      the settings namespace — which is what makes the plugins tab dispatch it;
 *   3. a host WITHOUT the settingsScope client service still gets the picker
 *      and no card (the graceful-degradation claim in the file header);
 *   4. the card renders both options, reflects the current mode, and writes the
 *      chosen one through the Host control route;
 *   5. every dictionary key the card asks for exists in BOTH languages.
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

const failures = [];
function check(condition, label) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL ${label}`);
  }
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

/**
 * Boot a fresh bundle instance (a new closure, so module-level state is clean).
 * `stateQueue` pins successive `useState` calls of the component under test;
 * `withSettingsScope` decides whether the host exposes the settings service.
 */
function boot({ withSettingsScope, stateQueue = [], fetchImpl }) {
  let registration;
  const window = { __ModuleLoader__: { load: (value) => { registration = value; } } };
  const document = {
    head: { appendChild() {} },
    createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: "" })
  };
  // The bundle is a script, not a module: evaluate it with its globals bound.
  new Function("window", "document", "fetch", "console", source)(window, document, fetchImpl, console);
  if (registration === undefined) throw new Error("bundle did not call window.__ModuleLoader__.load");

  const dictionaries = {};
  const registrations = [];
  const react = {
    useState(initial) {
      const next = stateQueue.length > 0 ? stateQueue.shift() : (typeof initial === "function" ? initial() : initial);
      return [next, () => {}];
    },
    useEffect() {},
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
  return { module, registrations, dictionaries };
}

const okJson = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

// ---------------------------------------------------------------------------

console.log("dsh-approval-mode: client bundle contract");

// 1 + 2: a complete host registers both surfaces.
{
  const { module, registrations } = boot({ withSettingsScope: true, fetchImpl: () => okJson({ ok: true, mode: "ask" }) });
  const picker = registrations.find((entry) => entry.slot === "conversation.input.left");
  const card = registrations.find((entry) => entry.slot === "settings.plugin.item");
  check(module.name === "dsh-approval-mode", "bundle exports the plugin name");
  check(Array.isArray(module.inject) && module.inject.includes("slots") && module.inject.includes("locale"), "bundle injects slots + locale");
  check(picker !== undefined && picker.options.id === "approval-mode-select", "picker registered in conversation.input.left");
  check(picker !== undefined && picker.options.locale === NS, "picker binds the approval-mode dictionary");
  check(card !== undefined && card.options.key === NS, "plugin card registered into settings.plugin.item keyed by the settings namespace");
  check(card !== undefined && card.options.locale === NS, "plugin card binds the approval-mode dictionary");
}

// 3: an older host without settingsScope keeps the picker and loses only the card.
{
  const { registrations } = boot({
    withSettingsScope: false,
    fetchImpl: () => Promise.reject(new Error("this check must not fetch"))
  });
  check(registrations.some((entry) => entry.slot === "conversation.input.left"), "without settingsScope the picker is still registered");
  check(!registrations.some((entry) => entry.slot === "settings.plugin.item"), "without settingsScope no plugin card is registered");
}

// 4 + 5: render the expanded card against a bypass-mode host and switch it.
{
  const requests = [];
  const fetchImpl = (url, init) => {
    requests.push({ url, method: init?.method ?? "GET", body: init?.body });
    return init?.method === "POST" ? okJson({ ok: true }) : okJson({ ok: true, mode: "bypass" });
  };
  const snapshot = { mode: "bypass", ready: true, saving: false, failed: false };
  const { registrations, dictionaries } = boot({ withSettingsScope: true, stateQueue: [snapshot, true], fetchImpl });
  const card = registrations.find((entry) => entry.slot === "settings.plugin.item");
  const zh = dictionaries[NS]?.zh ?? {};
  const en = dictionaries[NS]?.en ?? {};

  const asked = [];
  const tree = card.component({ t: (key) => { asked.push(key); return zh[key] ?? key; } });

  const texts = collectText(tree).join(" | ");
  check(tree.type === "li", "card renders a list item (the tab's container is a <ul>)");
  check(texts.includes(zh["card.title"]), "card header shows the plugin title");
  check(texts.includes(zh["item.ask"]) && texts.includes(zh["item.bypass"]), "card shows both mode options");
  check(texts.includes(zh["card.hint.bypass"]), "card explains the currently selected mode");

  const radios = findBy(tree, (node) => node.props?.role === "radio");
  check(radios.length === 2, "card renders exactly two radio options");
  const asks = radios.find((node) => collectText(node).join("").includes(zh["item.ask"]));
  const bypasses = radios.find((node) => collectText(node).join("").includes(zh["item.bypass"]));
  check(bypasses?.props?.["aria-checked"] === true, "the current mode is the checked option");
  check(asks?.props?.["aria-checked"] === false, "the other option is not checked");

  asks?.props?.onClick?.();
  await new Promise((resolve) => setImmediate(resolve));
  const post = requests.find((entry) => entry.method === "POST");
  check(post !== undefined && post.url === ROUTE, "choosing a mode POSTs to the Host control route");
  check(post !== undefined && post.body === JSON.stringify({ mode: "ask" }), "the POST body carries the chosen mode");

  const missing = asked.filter((key) => zh[key] === undefined || en[key] === undefined);
  check(asked.length > 0 && missing.length === 0, `every card key exists in zh and en${missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""}`);
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} client bundle check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nall client bundle checks passed");
