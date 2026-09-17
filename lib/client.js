/**
 * dsh-approval-mode — Client half (web bundle).
 *
 * Two surfaces, one setting:
 *
 *   1. The approval-mode picker (默认审批 / 绕过审批) in the composer tool row
 *      seat `conversation.input.left` — the seat right next to the permission
 *      (access mode) selector. Visual style mirrors PermissionSelect: a pill
 *      trigger button with an upward popup menu.
 *   2. The plugin's card on the settings page (设置 → 插件 → 插件配置), which is
 *      the configuration page for the default approval mode. The card is
 *      registered into the `settings.plugin.item` slot keyed by this plugin's
 *      settings namespace, which is how the plugins tab pairs a served
 *      namespace with the browser half that owns its card.
 *
 * Both surfaces read and write the SAME Host setting through the Host control
 * route (`GET/POST /approval-mode`, same-origin fetch) and share one
 * module-level store, so a change made on either one is reflected by the other
 * without a reload.
 *
 * i18n: registers the "approval-mode" dictionary (zh/en) with the DSH locale
 * service; slot owners inject the bound `t` via the `locale` registration
 * option, so all copy follows the DSH UI language automatically.
 *
 * Version posture: the card is registered through a NESTED
 * `ctx.inject(["settingsScope"], …)`, not through a module-level `inject`.
 * A host without that client service (before dsh 0.1.0-rc.7) simply never
 * creates the card, and the picker keeps working — a module-level dependency
 * would instead keep the whole plugin unmounted.
 *
 * Bundle format: `window.__ModuleLoader__.load({ id, factory })` — the DSH web
 * client module system (CJS-style factory; "react" resolves to the platform
 * seed module). No bundler is required to produce this file.
 */
window.__ModuleLoader__.load({
  id: "dsh-approval-mode",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");

    /** Locale dictionary namespace owned by this plugin (also the settings namespace). */
    var NS = "approval-mode";
    /** Slot cell key in conversation.input.left. */
    var APPROVAL_MODE_SELECT_ID = "approval-mode-select";
    /** Host control route (same origin as the served GUI). */
    var ROUTE_PATH = "/approval-mode";

    /** Simplified fallback interpolation for the zh dictionary (no locale service). */
    function fallbackT(key, params) {
      var text = zh[key] || key;
      if (params) {
        for (var name of Object.keys(params)) {
          text = text.split("{" + name + "}").join(String(params[name]));
        }
      }
      return text;
    }

    var zh = {
      "mode.ask": "默认审批",
      "mode.bypass": "绕过审批",
      "mode.unknown": "审批模式未知",
      "title.ask": "审批模式：默认审批 —— 工具调用需要点击审批",
      "title.bypass": "审批模式：绕过审批 —— 所有工具调用自动批准（高风险）",
      "title.unknown": "审批模式：读取当前设置失败（无法与 DSH 通信），暂不可切换。",
      "title.fullAccess": "当前会话权限为 Full Access：DSH 直接放行且不再发起审批请求，审批模式不可切换。",
      "aria.mode": "审批模式，当前：{mode}",
      "item.ask": "默认审批",
      "item.bypass": "绕过审批",
      "card.title": "审批模式",
      "card.desc": "设置打开会话时使用的审批模式。",
      "card.rowLabel": "默认审批模式",
      "card.hint.ask": "工具调用需要点击批准，与 DSH 原生行为一致。",
      "card.hint.bypass": "所有工具调用自动批准，不弹出审批提示（高风险）。",
      "card.loading": "正在读取当前设置…",
      "card.saving": "正在保存…",
      "card.error": "读写设置失败：无法与 DSH 通信，当前显示的审批模式可能不是实际设置。",
      "card.footnote": "全局设置，立即生效并持久保存；输入框工具栏的「审批模式」按钮修改的是同一个值。",
      "card.aria.options": "默认审批模式"
    };

    var en = {
      "mode.ask": "Default approval",
      "mode.bypass": "Bypass approval",
      "mode.unknown": "Approval mode unknown",
      "title.ask": "Approval mode: default — tool calls require a click to approve",
      "title.bypass": "Approval mode: bypass — every tool call is auto-approved (high risk)",
      "title.unknown": "Approval mode: the current setting could not be read (the DSH host is unreachable), so it cannot be switched.",
      "title.fullAccess": "Session permission is Full Access: DSH passes everything through and never issues approval requests, so the mode cannot be switched.",
      "aria.mode": "Approval mode, current: {mode}",
      "item.ask": "Default approval",
      "item.bypass": "Bypass approval",
      "card.title": "Approval mode",
      "card.desc": "Set the approval mode sessions open with.",
      "card.rowLabel": "Default approval mode",
      "card.hint.ask": "Tool calls require a click to approve, the stock DSH behaviour.",
      "card.hint.bypass": "Every tool call is auto-approved and no approval prompt appears (high risk).",
      "card.loading": "Reading the current setting…",
      "card.saving": "Saving…",
      "card.error": "Could not read or write the setting: the DSH host is unreachable, so the approval mode shown may not be the actual setting.",
      "card.footnote": "One global setting, applied immediately and persisted; the composer toolbar's approval-mode button writes the same value.",
      "card.aria.options": "Default approval mode"
    };

    var APPROVAL_MODE_CSS = [
      ".dsh-approval-mode-root{position:relative;display:inline-flex}",
      ".dsh-approval-mode-trigger{min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}",
      ".dsh-approval-mode-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-approval-mode-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}",
      ".dsh-approval-mode-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
      ".dsh-approval-mode-trigger.bypass{color:var(--dsw-alias-state-warn-primary)}",
      ".dsh-approval-mode-triggerIcon{flex:none;display:inline-flex}",
      ".dsh-approval-mode-triggerIcon svg{width:14px;height:14px}",
      ".dsh-approval-mode-triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}",
      ".dsh-approval-mode-chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s;display:inline-flex}",
      ".dsh-approval-mode-chevron.open{transform:rotate(180deg)}",
      ".dsh-approval-mode-menu{position:absolute;bottom:calc(100% + 6px);left:0;min-width:168px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:4px;z-index:1000;display:flex;flex-direction:column}",
      ".dsh-approval-mode-item{display:flex;align-items:center;gap:8px;height:32px;padding:0 8px;border:none;background:none;border-radius:6px;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;width:100%;font-family:inherit}",
      ".dsh-approval-mode-item:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-approval-mode-item.selected{color:var(--dsw-alias-brand-primary)}",
      ".dsh-approval-mode-item.danger{color:var(--dsw-alias-state-warn-primary)}",
      ".dsh-approval-mode-item .dsh-approval-mode-itemCheck{margin-left:auto;display:inline-flex;flex:none}",
      ".dsh-approval-mode-item .dsh-approval-mode-itemCheck svg{width:14px;height:14px}",
      ".dsh-approval-mode-itemIcon{flex:none;display:inline-flex}",
      ".dsh-approval-mode-itemIcon svg{width:14px;height:14px}",
      // Plugin-page card. Chrome mirrors the host's own PluginCard (settings tab)
      // one for one, because a card the tab lays out must not look foreign.
      ".dsh-approval-mode-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}",
      ".dsh-approval-mode-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
      ".dsh-approval-mode-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
      ".dsh-approval-mode-cardHeader{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
      ".dsh-approval-mode-cardHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
      ".dsh-approval-mode-cardHeadText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
      ".dsh-approval-mode-cardName{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
      ".dsh-approval-mode-cardDesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
      ".dsh-approval-mode-cardChevron{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex;transition:transform .16s}",
      ".dsh-approval-mode-cardChevronOpen{transform:rotate(180deg)}",
      ".dsh-approval-mode-cardBody{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}",
      ".dsh-approval-mode-cardRow{display:flex;align-items:center;gap:12px;padding:12px 0}",
      ".dsh-approval-mode-cardLabelBox{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}",
      ".dsh-approval-mode-cardLabel{font-size:13px;line-height:20px}",
      ".dsh-approval-mode-cardHint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-approval-mode-cardHint.error{color:var(--dsw-alias-label-error)}",
      ".dsh-approval-mode-cardSeg{display:inline-flex;flex-shrink:0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:2px;gap:2px}",
      ".dsh-approval-mode-cardSegBtn{font:inherit;font-size:12px;line-height:18px;padding:3px 10px;border:none;border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".dsh-approval-mode-cardSegBtn:disabled{cursor:default;opacity:.5}",
      ".dsh-approval-mode-cardSegBtn.selected{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}",
      ".dsh-approval-mode-cardSegBtn.selected.danger{color:var(--dsw-alias-state-warn-primary)}",
      ".dsh-approval-mode-cardFoot{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;border-top:.5px solid var(--dsw-alias-border-l2);margin-top:12px;padding:12px 0 4px}"
    ].join("\n");

    /** @returns whether the page runs on the loopback DSH origin (same-origin fetch). */
    function canFetch() {
      return typeof fetch === "function";
    }

    /** Read the current mode from the Host control route. */
    function readMode() {
      return fetch(ROUTE_PATH).then((response) => {
        if (!response.ok) throw new Error("GET " + ROUTE_PATH + " -> HTTP " + response.status);
        return response.json();
      }).then((value) => {
        return value && value.mode === "bypass" ? "bypass" : "ask";
      });
    }

    /** Write the mode through the Host control route. */
    function writeMode(mode) {
      return fetch(ROUTE_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode })
      }).then((response) => {
        if (!response.ok) return false;
        return response.json().then((value) => !!(value && value.ok === true));
      });
    }

    /**
     * One shared view of the Host setting, so the picker and the plugin-page
     * card cannot disagree: whichever surface writes, the other re-renders.
     *
     * The read is lazy (first subscriber) and never repeated after it settles.
     * Invariants that the surfaces rely on:
     *
     * - `known` says whether `mode` is a value the HOST actually reported. A
     *   failed initial read leaves it false, so a surface shows "unknown"
     *   instead of presenting the schema default as the setting.
     * - `confirmed` is the last value the Host confirmed — by a read or by a
     *   successful write — and it is the ONLY thing a failed write restores.
     *   Restoring the previous optimistic value instead would show a mode the
     *   Host never accepted when two selections overlap.
     * - `generation` guards both directions: a write settles only for the
     *   newest selection, and a read whose result a later selection superseded
     *   is dropped rather than publishing a stale mode. A superseded write that
     *   SUCCEEDED still updates `confirmed`, because the Host applied it.
     */
    var modeStore = {
      state: { mode: "ask", ready: false, known: false, saving: false, failed: false },
      /** Last value the Host confirmed; the restore point for a failed write. */
      confirmed: { mode: "ask", known: false },
      /** Generation that produced {@link modeStore.confirmed}, so a late response cannot regress it. */
      confirmedGeneration: 0,
      listeners: [],
      loading: null,
      generation: 0,
      get: function () {
        return modeStore.state;
      },
      subscribe: function (listener) {
        modeStore.listeners.push(listener);
        if (!modeStore.state.ready && !modeStore.loading) modeStore.load();
        return function () {
          var index = modeStore.listeners.indexOf(listener);
          if (index >= 0) modeStore.listeners.splice(index, 1);
        };
      },
      publish: function (next) {
        modeStore.state = next;
        modeStore.listeners.slice().forEach((listener) => {
          try {
            listener(next);
          } catch (err) {
            console.error("[dsh-approval-mode] subscriber failed:", err);
          }
        });
      },
      load: function () {
        if (modeStore.loading) return modeStore.loading;
        var generation = modeStore.generation;
        if (!canFetch()) {
          // No transport at all: the value is unknowable, and saying so is the
          // only honest state — the same one a failed read produces.
          modeStore.publish({ mode: "ask", ready: true, known: false, saving: false, failed: true });
          return Promise.resolve(modeStore.state);
        }
        modeStore.loading = readMode().then((mode) => {
          modeStore.loading = null;
          // A selection made while this read was in flight owns the state now.
          if (generation !== modeStore.generation) return modeStore.state;
          modeStore.confirmed = { mode, known: true };
          modeStore.publish({ mode, ready: true, known: true, saving: false, failed: false });
          return modeStore.state;
        }).catch((err) => {
          modeStore.loading = null;
          console.error("[dsh-approval-mode] read failed:", err);
          if (generation !== modeStore.generation) return modeStore.state;
          modeStore.publish({ mode: "ask", ready: true, known: false, saving: false, failed: true });
          return modeStore.state;
        });
        return modeStore.loading;
      },
      select: function (mode) {
        var generation = ++modeStore.generation;
        modeStore.publish({ mode, ready: true, known: true, saving: true, failed: false });
        if (!canFetch()) {
          modeStore.publish({ mode: "ask", ready: true, known: false, saving: false, failed: true });
          return Promise.resolve(false);
        }
        return writeMode(mode).then((ok) => {
          // The Host applied it even if a newer selection already took over,
          // so this stays the restore point until something else succeeds —
          // but responses can arrive out of order, and only the NEWEST success
          // may become the restore point.
          if (ok && generation > modeStore.confirmedGeneration) {
            modeStore.confirmedGeneration = generation;
            modeStore.confirmed = { mode, known: true };
          }
          if (generation !== modeStore.generation) return ok;
          if (!ok) {
            modeStore.publish({
              mode: modeStore.confirmed.mode,
              ready: true,
              known: modeStore.confirmed.known,
              saving: false,
              failed: true
            });
            return false;
          }
          modeStore.publish({ mode, ready: true, known: true, saving: false, failed: false });
          return true;
        }).catch((err) => {
          console.error("[dsh-approval-mode] write failed:", err);
          if (generation !== modeStore.generation) return false;
          modeStore.publish({
            mode: modeStore.confirmed.mode,
            ready: true,
            known: modeStore.confirmed.known,
            saving: false,
            failed: true
          });
          return false;
        });
      }
    };

    /** Subscribe a surface to the shared mode store (loads it on first use). */
    function useMode() {
      var pair = react.useState(modeStore.get());
      var setSnapshot = pair[1];
      react.useEffect(() => modeStore.subscribe(setSnapshot), []);
      return pair[0];
    }

    function svg(pathD, opts) {
      var filled = opts && opts.filled;
      return react.createElement("svg", {
        width: 14,
        height: 14,
        viewBox: "0 0 14 14",
        fill: filled ? "currentColor" : "none",
        stroke: filled ? "none" : "currentColor",
        strokeWidth: 1.4,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true
      }, react.createElement("path", { d: pathD }));
    }

    var ICON_SHIELD = "M7 1.2L12.2 3.3V7C12.2 10.2 9.9 12.7 7 13.3C4.1 12.7 1.8 10.2 1.8 7V3.3L7 1.2Z";
    var ICON_BOLT = "M7.8 1L3 8H6.4L5.4 13L11 6H7.4L7.8 1Z";
    var ICON_CHECK = "M3 7.5L6 10.5L11 4";
    var ICON_CHEVRON = "M3 5.5L7 9.5L11 5.5";

    /** Plugin context captured at apply time (slot components receive no ctx prop). */
    var pluginCtx = null;

    function ApprovalModeSelect(props) {
      // Translate function from the locale seat (injected via the `locale` registration option).
      var t = typeof props.t === "function" ? props.t : fallbackT;
      var snapshot = useMode();
      var mode = snapshot.mode;
      var ready = snapshot.ready;
      // `known` is false when no Host value was read: the control must not
      // present the schema default as if it were the current setting.
      var known = snapshot.known;
      // 当前会话的权限投影（standard props 注入；Full Access 时审批模式不可切换）
      var permissions = typeof props.useProjection === "function" ? props.useProjection("permissions") : null;
      var fullAccess = !!(permissions && permissions.currentValue === "danger-full-access");
      var openPair = react.useState(false);
      var open = openPair[0];
      var setOpen = openPair[1];

      // 点击外部 / Escape 关闭菜单
      react.useEffect(() => {
        if (!open) return undefined;
        var onDown = (e) => {
          var target = e.target;
          if (!(target instanceof Element) || !target.closest(".dsh-approval-mode-root")) {
            setOpen(false);
          }
        };
        var onKey = (e) => {
          if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [open, setOpen]);

      var toggle = () => setOpen(!open);
      var select = (next) => {
        if (fullAccess) return;
        setOpen(false);
        // The store reverts to the previous value if the Host refuses the write.
        modeStore.select(next);
      };

      var bypass = known && mode === "bypass";
      // Full Access 时 DSH 不会发起审批请求（策略 never 直接放行/拒绝），
      // 模式不可切换：显示「绕过审批」（与实际行为一致）且置灰。
      var effectiveBypass = bypass || fullAccess;
      var label = known ? t(effectiveBypass ? "mode.bypass" : "mode.ask") : t("mode.unknown");
      var title = !known
        ? t("title.unknown")
        : fullAccess
          ? t("title.fullAccess")
          : t(effectiveBypass ? "title.bypass" : "title.ask");

      return react.createElement("div", { className: "dsh-approval-mode-root" },
        react.createElement("button", {
          type: "button",
          className: "dsh-approval-mode-trigger" + (bypass && !fullAccess ? " bypass" : ""),
          disabled: !ready || !known || fullAccess,
          onClick: toggle,
          "aria-label": t("aria.mode", { mode: label }),
          "aria-haspopup": "menu",
          "aria-expanded": open,
          title
        },
          react.createElement("span", { className: "dsh-approval-mode-triggerIcon" },
            svg(effectiveBypass ? ICON_BOLT : ICON_SHIELD, { filled: true })),
          react.createElement("span", { className: "dsh-approval-mode-triggerLabel" }, label),
          react.createElement("span", { className: "dsh-approval-mode-chevron" + (open ? " open" : "") },
            svg(ICON_CHEVRON))
        ),
        open && react.createElement("div", { className: "dsh-approval-mode-menu", role: "menu" },
          react.createElement("button", {
            type: "button",
            role: "menuitem",
            className: "dsh-approval-mode-item" + (known && mode === "ask" ? " selected" : ""),
            onClick: () => select("ask")
          },
            react.createElement("span", { className: "dsh-approval-mode-itemIcon" }, svg(ICON_SHIELD, { filled: true })),
            react.createElement("span", null, t("item.ask")),
            known && mode === "ask" && react.createElement("span", { className: "dsh-approval-mode-itemCheck" }, svg(ICON_CHECK))
          ),
          react.createElement("button", {
            type: "button",
            role: "menuitem",
            className: "dsh-approval-mode-item danger" + (known && mode === "bypass" ? " selected" : ""),
            onClick: () => select("bypass")
          },
            react.createElement("span", { className: "dsh-approval-mode-itemIcon" }, svg(ICON_BOLT, { filled: true })),
            react.createElement("span", null, t("item.bypass")),
            known && mode === "bypass" && react.createElement("span", { className: "dsh-approval-mode-itemCheck" }, svg(ICON_CHECK))
          )
        )
      );
    }

    /**
     * The plugin's card on the settings page (设置 → 插件 → 插件配置).
     *
     * The plugins tab renders one card per SERVED settings namespace, so this
     * registration is keyed by {@link NS}: a deployment that does not compose
     * the Host half never dispatches it. The card owns its whole appearance —
     * the tab contributes only the `<ul>` — so its chrome mirrors the host's
     * own PluginCard rather than importing it (cross-plugin value imports are
     * not available to a client bundle).
     */
    function ApprovalModeSettingsCard(props) {
      var t = typeof props.t === "function" ? props.t : fallbackT;
      var snapshot = useMode();
      var openPair = react.useState(false);
      var open = openPair[0];
      var setOpen = openPair[1];
      var bypass = snapshot.known && snapshot.mode === "bypass";
      var busy = !snapshot.ready || snapshot.saving;

      // One line under the control, always: what the current value means, or
      // why it cannot be trusted right now. A card that silently showed a
      // stale value would be read as the setting itself.
      var hintKey = bypass ? "card.hint.bypass" : "card.hint.ask";
      var hint = !snapshot.ready
        ? t("card.loading")
        : snapshot.failed || !snapshot.known
          ? t("card.error")
          : snapshot.saving
            ? t("card.saving")
            : t(hintKey);

      var option = (value, labelKey) => {
        // No option is marked while the Host value is unknown: a checked radio
        // would assert a setting that was never read.
        var selected = snapshot.known && snapshot.mode === value;
        return react.createElement("button", {
          key: value,
          type: "button",
          role: "radio",
          "aria-checked": selected,
          className: "dsh-approval-mode-cardSegBtn" + (selected ? " selected" : "") + (value === "bypass" ? " danger" : ""),
          disabled: busy,
          onClick: () => {
            if (!selected) modeStore.select(value);
          }
        }, t(labelKey));
      };

      return react.createElement("li", { className: "dsh-approval-mode-card" + (open ? " dsh-approval-mode-cardOpen" : "") },
        react.createElement("button", {
          type: "button",
          className: "dsh-approval-mode-cardHeader",
          "aria-expanded": open,
          onClick: () => setOpen(!open)
        },
          react.createElement("span", { className: "dsh-approval-mode-cardHeadText" },
            react.createElement("span", { className: "dsh-approval-mode-cardName" }, t("card.title")),
            react.createElement("span", { className: "dsh-approval-mode-cardDesc" }, t("card.desc"))
          ),
          react.createElement("span", { className: "dsh-approval-mode-cardChevron" + (open ? " dsh-approval-mode-cardChevronOpen" : "") },
            svg(ICON_CHEVRON))
        ),
        open && react.createElement("div", { className: "dsh-approval-mode-cardBody" },
          react.createElement("div", { className: "dsh-approval-mode-cardRow" },
            react.createElement("div", { className: "dsh-approval-mode-cardLabelBox" },
              react.createElement("div", { className: "dsh-approval-mode-cardLabel" }, t("card.rowLabel")),
              react.createElement("div", {
                className: "dsh-approval-mode-cardHint" + (snapshot.failed ? " error" : ""),
                role: "status"
              }, hint)
            ),
            react.createElement("div", {
              className: "dsh-approval-mode-cardSeg",
              role: "radiogroup",
              "aria-label": t("card.aria.options")
            },
              option("ask", "item.ask"),
              option("bypass", "item.bypass")
            )
          ),
          react.createElement("div", { className: "dsh-approval-mode-cardFoot" }, t("card.footnote"))
        )
      );
    }

    /** Stable Cordis plugin name. */
    var name = "dsh-approval-mode";
    /** Required runtime services: slots (UI seats), locale (i18n dictionaries). */
    var inject = ["slots", "locale"];

    function apply(ctx) {
      pluginCtx = ctx;

      // Register the zh/en dictionaries with the DSH locale service.
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-approval-mode: locale");

      // Inject the control stylesheet; removed with the plugin fiber.
      var style = document.createElement("style");
      style.setAttribute("data-dsh-approval-mode", "");
      style.textContent = APPROVAL_MODE_CSS;
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), "dsh-approval-mode: styles");

      // Register the picker into the seat beside the permission selector.
      // `locale: NS` makes the owner inject the bound translate function as `t`.
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
        name: "conversation.input.left",
        id: APPROVAL_MODE_SELECT_ID,
        order: 50,
        label: "审批模式",
        locale: NS
      }, ApprovalModeSelect));

      // Configuration page: the plugin's card in 设置 → 插件 → 插件配置, keyed by
      // the settings namespace the card edits. Nested inject on purpose — see
      // the Version posture note in this file's header.
      ctx.inject(["settingsScope"], (scoped) => {
        scoped.slots.inject("settings.plugin.item", () => scoped.slots.register({
          name: "settings.plugin.item",
          key: NS,
          locale: NS
        }, ApprovalModeSettingsCard));
      });
    }

    module.exports = { name, inject, apply };
    return module.exports;
  }
});
