/**
 * dsh-approval-mode — Client half (web bundle).
 *
 * Renders the approval-mode picker (默认审批 / 绕过审批) in the composer tool
 * row seat `conversation.input.left` — the seat right next to the permission
 * (access mode) selector. Visual style mirrors PermissionSelect: a pill
 * trigger button with an upward popup menu.
 *
 * State lives in the Host settings namespace "approval-mode"; this half reads
 * and writes it through the standard settings RPC (connection.api.settings.
 * describe / mutate), same channel the built-in settings surfaces use.
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

    /** Settings namespace owned by the Host half. */
    var NS = "approval-mode";
    /** Slot cell key in conversation.input.left. */
    var APPROVAL_MODE_SELECT_ID = "approval-mode-select";
    /** Host control route (same origin as the served GUI). */
    var ROUTE_PATH = "/approval-mode";

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
      ".dsh-approval-mode-itemIcon svg{width:14px;height:14px}"
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
        return {
          mode: value && value.mode === "bypass" ? "bypass" : "ask",
          revision: undefined
        };
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
      var ctx = pluginCtx;
      var api = canFetch() ? readMode : null;
      // 当前会话的权限投影（standard props 注入；Full Access 时审批模式不可切换）
      var permissions = typeof props.useProjection === "function" ? props.useProjection("permissions") : null;
      var fullAccess = !!(permissions && permissions.currentValue === "danger-full-access");
      var state = react.useState({ mode: "ask", ready: false, open: false, revision: undefined });
      var mode = state[0].mode;
      var ready = state[0].ready;
      var open = state[0].open;
      var revision = state[0].revision;
      var setState = state[1];

      react.useEffect(() => {
        if (!api) {
          setState({ mode: "ask", ready: true, open: false, revision: undefined });
          return undefined;
        }
        var alive = true;
        api().then((read) => {
          if (!alive) return;
          setState({ mode: read.mode, ready: true, open: false, revision: read.revision });
        }).catch((err) => {
          console.error("[dsh-approval-mode] read failed:", err);
          if (alive) setState({ mode: "ask", ready: true, open: false, revision: undefined });
        });
        return () => {
          alive = false;
        };
      }, [api]);

      // 点击外部 / Escape 关闭菜单
      react.useEffect(() => {
        if (!open) return undefined;
        var onDown = (e) => {
          var target = e.target;
          if (!(target instanceof Element) || !target.closest(".dsh-approval-mode-root")) {
            setState((s) => ({ ...s, open: false }));
          }
        };
        var onKey = (e) => {
          if (e.key === "Escape") setState((s) => ({ ...s, open: false }));
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [open, setState]);

      var toggle = () => setState((s) => ({ ...s, open: !s.open }));
      var select = (next) => {
        setState({ mode: next, ready: true, open: false, revision });
        if (!api) return;
        writeMode(next).then((ok) => {
          if (!ok) setState((s) => ({ ...s, mode: "ask", revision: undefined }));
        }).catch((err) => {
          console.error("[dsh-approval-mode] write failed:", err);
          setState((s) => ({ ...s, mode: "ask", revision: undefined }));
        });
      };

      var bypass = mode === "bypass";
      // Full Access 时 DSH 不会发起审批请求（策略 never 直接放行/拒绝），
      // 模式不可切换：显示「绕过审批」（与实际行为一致）且置灰。
      var effectiveBypass = bypass || fullAccess;
      var label = effectiveBypass ? "绕过审批" : "默认审批";

      return react.createElement("div", { className: "dsh-approval-mode-root" },
        react.createElement("button", {
          type: "button",
          className: "dsh-approval-mode-trigger" + (bypass && !fullAccess ? " bypass" : ""),
          disabled: !ready || fullAccess,
          onClick: toggle,
          "aria-label": "审批模式，当前：" + label,
          "aria-haspopup": "menu",
          "aria-expanded": open,
          title: fullAccess
            ? "当前会话权限为 Full Access：DSH 直接放行且不再发起审批请求，审批模式不可切换。"
            : (effectiveBypass
              ? "审批模式：绕过审批 —— 所有工具调用自动批准（高风险）"
              : "审批模式：默认审批 —— 工具调用需要点击审批")
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
            className: "dsh-approval-mode-item" + (mode === "ask" ? " selected" : ""),
            onClick: () => select("ask")
          },
            react.createElement("span", { className: "dsh-approval-mode-itemIcon" }, svg(ICON_SHIELD, { filled: true })),
            react.createElement("span", null, "默认审批"),
            mode === "ask" && react.createElement("span", { className: "dsh-approval-mode-itemCheck" }, svg(ICON_CHECK))
          ),
          react.createElement("button", {
            type: "button",
            role: "menuitem",
            className: "dsh-approval-mode-item danger" + (mode === "bypass" ? " selected" : ""),
            onClick: () => select("bypass")
          },
            react.createElement("span", { className: "dsh-approval-mode-itemIcon" }, svg(ICON_BOLT, { filled: true })),
            react.createElement("span", null, "绕过审批"),
            mode === "bypass" && react.createElement("span", { className: "dsh-approval-mode-itemCheck" }, svg(ICON_CHECK))
          )
        )
      );
    }

    /** Stable Cordis plugin name. */
    var name = "dsh-approval-mode";
    /** Required runtime services: slots (UI seat). The mode route is same-origin fetch. */
    var inject = ["slots"];

    function apply(ctx) {
      pluginCtx = ctx;

      // Inject the control stylesheet; removed with the plugin fiber.
      var style = document.createElement("style");
      style.setAttribute("data-dsh-approval-mode", "");
      style.textContent = APPROVAL_MODE_CSS;
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), "dsh-approval-mode: styles");

      // Register the picker into the seat beside the permission selector.
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
        name: "conversation.input.left",
        id: APPROVAL_MODE_SELECT_ID,
        order: 50,
        label: "审批模式"
      }, ApprovalModeSelect));
    }

    module.exports = { name, inject, apply };
    return module.exports;
  }
});
