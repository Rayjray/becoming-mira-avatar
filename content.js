// Generic `data-agent-*` wizard driver — Webfuse custom MCP tools.
//
// This content script knows NOTHING about any specific form. It discovers the
// active screen and its controls from `data-agent-*` attributes at call time and
// drives them through the Automation API. Any page that speaks the contract in
// docs/instrument-a-form.md is driven out of the box — the form owner can add,
// remove or reorder fields and questions without touching this file.
//
// That is the whole point: the knowledge lives in the markup, not here.
//
// Why the Automation API and not direct DOM mutation: target forms are usually
// React controlled components. Setting `input.value` directly is ignored by
// React's synthetic event system, while act.type/act.click dispatch real user
// events — and they render visible pointer/typing feedback in the session UI so
// a human co-browsing can follow along.
//
// Contract summary (see docs/instrument-a-form.md for the authoritative version):
//   data-agent-screen   kind of screen: question | form | loading | done | error
//   data-agent-step     stable unique key for the screen
//   data-agent-role     option | input | next | back | submit | restart | action
//   data-agent-value    stable value for an option or an action
//   data-agent-field    stable key for an input or a read-only output
//   data-agent-selected "true" on the currently chosen option
//   data-agent-label    optional explicit label override
//   reserved fields     progress | reference | error | content

console.log("[wizard] content script loaded", { url: location.href });

const A = () => browser.webfuseSession.automation;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const NAV_ROLES = ["next", "back", "submit", "restart"];

// --- DOM helpers ---------------------------------------------------------

const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(String(v)) : String(v).replace(/"/g, '\\"'));

// offsetParent is null for display:none and for detached nodes; getClientRects
// covers position:fixed elements, which have no offsetParent but are visible.
function isVisible(el) {
  if (!el) return false;
  if (el.hidden) return false;
  return el.offsetParent !== null || el.getClientRects().length > 0;
}

// The one screen the user is looking at. The contract requires exactly one
// visible [data-agent-screen]; if a page breaks that we take the first, because
// a wrong-but-deterministic answer is easier to debug than a random one.
function activeScreen() {
  const all = [...document.querySelectorAll("[data-agent-screen]")];
  const visible = all.filter(isVisible);
  if (visible.length > 1) {
    console.warn("[wizard] multiple visible screens, using the first:",
      visible.map((el) => el.getAttribute("data-agent-step")));
  }
  return visible[0] || null;
}

// Human-readable label for an element: explicit override, then its own text,
// then the usual accessibility fallbacks.
function labelOf(el) {
  const explicit = el.getAttribute("data-agent-label");
  if (explicit) return explicit;

  const lines = (el.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (lines.length) return lines[0];

  if (el.id) {
    const lab = document.querySelector(`label[for="${esc(el.id)}"]`);
    if (lab && lab.innerText.trim()) return lab.innerText.trim();
  }
  const wrapping = el.closest("label");
  if (wrapping && wrapping.innerText.trim()) return wrapping.innerText.trim();

  return el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
}

// Second line of a multi-line button is treated as its description.
function descriptionOf(el) {
  if (el.getAttribute("data-agent-label")) return "";
  const lines = (el.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
  return lines[1] || "";
}

// Selectors are built from the data attributes themselves, scoped by step, so
// they stay valid across re-renders (React reorders and recreates nodes).
function scopeSelector(screen) {
  const step = screen && screen.getAttribute("data-agent-step");
  return step ? `[data-agent-step="${esc(step)}"]` : "";
}

// --- Reading the screen --------------------------------------------------

function readOptions(screen, scope) {
  return [...screen.querySelectorAll('[data-agent-role="option"]')].map((el) => ({
    value: el.getAttribute("data-agent-value"),
    label: labelOf(el),
    description: descriptionOf(el),
    selected: el.getAttribute("data-agent-selected") === "true"
      || el.getAttribute("aria-pressed") === "true"
      || el.getAttribute("aria-checked") === "true",
    disabled: !!el.disabled,
    selector: `${scope} [data-agent-role="option"][data-agent-value="${esc(el.getAttribute("data-agent-value"))}"]`,
  }));
}

function readFields(screen, scope) {
  return [...screen.querySelectorAll('[data-agent-role="input"]')]
    .filter((el) => el.type !== "file") // file inputs cannot be automated
    .map((el) => {
      const field = el.getAttribute("data-agent-field");
      const base = {
        field,
        label: labelOf(el),
        type: el.tagName === "SELECT" ? "select" : (el.type || "text"),
        required: !!el.required,
        disabled: !!el.disabled,
        selector: `${scope} [data-agent-field="${esc(field)}"]`,
      };
      if (el.tagName === "SELECT") {
        base.value = el.value;
        base.options = [...el.options].map((o) => ({ value: o.value, label: o.text }));
      } else if (el.type === "checkbox" || el.type === "radio") {
        base.value = el.value;
        base.checked = !!el.checked;
      } else {
        base.value = el.value;
      }
      return base;
    });
}

function readActions(screen, scope) {
  return [...screen.querySelectorAll('[data-agent-role="action"]')].map((el) => ({
    value: el.getAttribute("data-agent-value"),
    label: labelOf(el),
    disabled: !!el.disabled,
    selector: `${scope} [data-agent-role="action"][data-agent-value="${esc(el.getAttribute("data-agent-value"))}"]`,
  }));
}

// Navigation controls may live OUTSIDE the screen container — a persistent nav
// bar or footer is common (and is how the quickscan renders its Back button).
// Look inside the active screen first, then fall back to document scope.
function navControl(screen, scope, role) {
  const inScreen = screen.querySelector(`[data-agent-role="${role}"]`);
  if (inScreen) {
    return { el: inScreen, selector: `${scope} [data-agent-role="${role}"]` };
  }
  const globals = [...document.querySelectorAll(`[data-agent-role="${role}"]`)].filter(isVisible);
  if (globals.length) {
    return { el: globals[0], selector: `[data-agent-role="${role}"]` };
  }
  return null;
}

function readNav(screen, scope) {
  const nav = {};
  for (const role of NAV_ROLES) {
    const found = navControl(screen, scope, role);
    nav[role] = found ? { available: !found.el.disabled, label: labelOf(found.el) } : null;
  }
  return nav;
}

// Read-only outputs, looked up in the screen first and then document-wide so a
// global progress indicator is still picked up.
function readOutput(screen, key) {
  const el = screen.querySelector(`[data-agent-field="${esc(key)}"]`)
    || [...document.querySelectorAll(`[data-agent-field="${esc(key)}"]`)].filter(isVisible)[0];
  if (!el) return null;
  const text = (el.innerText || el.value || "").trim();
  return text || null;
}

function getStateObject() {
  const screen = activeScreen();
  if (!screen) {
    return {
      screen: "unknown",
      url: location.href,
      prompt: "No [data-agent-screen] is visible. The page may still be loading, or this page is not instrumented with the data-agent-* contract.",
      instrumented: document.querySelectorAll("[data-agent-screen]").length > 0,
    };
  }

  const kind = screen.getAttribute("data-agent-screen");
  const step = screen.getAttribute("data-agent-step");
  const scope = scopeSelector(screen);

  const state = {
    screen: kind,
    step,
    url: location.href,
    title: (screen.querySelector("h1, h2, h3") || {}).innerText || null,
    progress: readOutput(screen, "progress"),
    error: readOutput(screen, "error"),
  };
  if (state.title) state.title = state.title.trim();

  if (kind === "loading") {
    state.prompt = "The form is busy. Do not act — call wizard_get_state again in a moment.";
    return state;
  }

  state.options = readOptions(screen, scope);
  state.fields = readFields(screen, scope);
  state.actions = readActions(screen, scope);
  state.nav = readNav(screen, scope);

  const content = readOutput(screen, "content");
  if (content) state.content = content;

  if (kind === "done") {
    state.reference = readOutput(screen, "reference");
    state.prompt = "The form was submitted successfully. Tell the user, and read the reference if there is one."
      + (state.nav.restart ? " wizard_navigate {control:'restart'} starts over." : "");
    return state;
  }

  state.prompt = promptFor(state);
  return state;
}

// Guidance derived from what is actually on the screen — no per-form knowledge.
function promptFor(state) {
  const bits = [];

  if (state.error) bits.push(`There is an error on screen: "${state.error}". Tell the user and help them fix it.`);
  if (state.content) bits.push("Read the `content` field aloud to the user.");

  if (state.options.length) {
    const selected = state.options.find((o) => o.selected);
    bits.push(
      `Read the ${state.options.length} options to the user and call wizard_select_option with the matching \`value\`.`
      + (selected ? ` Currently selected: "${selected.value}".` : "")
      + " It advances automatically unless you pass advance:false.",
    );
  }
  if (state.fields.length) {
    bits.push(
      `Collect ${state.fields.map((f) => f.field).join(", ")} from the user and call wizard_fill_fields, then `
      + (state.nav.submit ? "wizard_navigate {control:'submit'}." : "wizard_navigate {control:'next'}."),
    );
  }
  if (!state.options.length && !state.fields.length && state.nav.next) {
    bits.push("Call wizard_navigate {control:'next'} to continue.");
  }
  if (state.actions.length) {
    bits.push(`Alternative actions available via wizard_action: ${state.actions.map((a) => a.value).join(", ")}.`);
  }

  return bits.join(" ") || "Nothing actionable on this screen — call wizard_get_state again shortly.";
}

// --- Waiting -------------------------------------------------------------
// React screen changes cause no page navigation, so the Automation API's
// page:stable event never fires. Poll a coarse signature instead, and never
// settle on a transient loading screen.

function signature() {
  const screen = activeScreen();
  if (!screen) return "none";
  const scope = scopeSelector(screen);
  const selected = [...screen.querySelectorAll('[data-agent-role="option"][data-agent-selected="true"]')]
    .map((el) => el.getAttribute("data-agent-value")).join(",");
  return [
    screen.getAttribute("data-agent-screen"),
    screen.getAttribute("data-agent-step"),
    selected,
    readOutput(screen, "error") || "",
    scope,
  ].join("|");
}

// Waits for a navigation control to exist AND be enabled, re-resolving it each
// poll because React swaps the node out on re-render. Returns null on timeout,
// which the caller treats as "nothing to press".
async function waitForEnabled(role, timeout = 1500, interval = 100) {
  const start = Date.now();
  for (;;) {
    const screen = activeScreen();
    if (screen) {
      const found = navControl(screen, scopeSelector(screen), role);
      if (found && !found.el.disabled) return found;
    }
    if (Date.now() - start >= timeout) return null;
    await delay(interval);
  }
}

async function settle(prevSig, { timeout = 15000, interval = 120 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await delay(interval);
    const screen = activeScreen();
    const kind = screen && screen.getAttribute("data-agent-screen");
    if (kind !== "loading" && signature() !== prevSig) return true;
  }
  return false; // timed out — the caller still returns fresh state
}

const fail = (text) => ({ isError: true, content: [{ type: "text", text }] });

// Every tool answers with the resulting state, so the agent never has to make a
// second round trip just to see what happened.
const respond = () => JSON.stringify(getStateObject());

// --- Tools ---------------------------------------------------------------

function registerTools() {
  if (!browser.webfuseSession || typeof browser.webfuseSession.registerTool !== "function") {
    console.warn("[wizard] registerTool unavailable — Webfuse runtime too old?");
    return;
  }

  // NOTE: annotations are deliberately { readOnlyHint: false } on ALL tools,
  // including the read-only one. With readOnlyHint:true the Session MCP server
  // routed calls down a path with no custom handler and answered
  // "Automation method not found: <tool>". Do not "fix" this back.
  const annotations = { readOnlyHint: false };

  browser.webfuseSession.registerTool({
    name: "wizard_get_state",
    description:
      "Read the current screen of a data-agent-* instrumented form: which step is shown, its selectable options, "
      + "its input fields, any alternative actions, which navigation controls are available, any error message, "
      + "and a `prompt` telling you what to do next. Call this first and after anything unexpected.",
    inputSchema: { type: "object", properties: {} },
    annotations,
    execute: async () => respond(),
  });

  browser.webfuseSession.registerTool({
    name: "wizard_select_option",
    description:
      "Choose one of the options on the current screen by its `value` from wizard_get_state. By default it also "
      + "presses Next afterwards so one call completes one question; pass advance:false to select without advancing "
      + "(useful when the user is still deciding). Returns the resulting state.",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string", description: "The option's `value` from wizard_get_state." },
        advance: { type: "boolean", description: "Press Next after selecting. Default true." },
      },
      required: ["value"],
    },
    annotations,
    execute: async ({ value, advance }) => {
      const screen = activeScreen();
      if (!screen) return fail("No active screen. Call wizard_get_state.");

      const scope = scopeSelector(screen);
      const options = readOptions(screen, scope);
      if (!options.length) {
        return fail(`The "${screen.getAttribute("data-agent-step")}" screen has no options. Call wizard_get_state.`);
      }
      const match = options.find((o) => String(o.value) === String(value));
      if (!match) {
        return fail(`Unknown option "${value}". Available: ${options.map((o) => o.value).join(", ")}.`);
      }
      if (match.disabled) return fail(`Option "${value}" is disabled.`);

      const prev = signature();
      await A().act.click(match.selector);

      if (advance !== false) {
        // Selecting an option usually enables Next, but the page needs a render
        // to do it. Poll briefly rather than guessing a fixed delay, and
        // re-resolve the control each time — React replaces the node.
        const next = await waitForEnabled("next", 1500);
        if (next) await A().act.click(next.selector);
      }

      await settle(prev);
      return respond();
    },
  });

  browser.webfuseSession.registerTool({
    name: "wizard_fill_fields",
    description:
      "Fill one or more input fields on the current screen. Pass an object keyed by the `field` names from "
      + "wizard_get_state, e.g. {\"postal-code\":\"9722 GP\",\"house-number\":\"10\"}. Handles text inputs, "
      + "selects, checkboxes and radios. Does NOT submit — follow up with wizard_navigate. Returns the resulting state.",
    inputSchema: {
      type: "object",
      properties: {
        fields: {
          type: "object",
          description: "Map of data-agent-field key to the value to enter. Use true/false for checkboxes.",
          additionalProperties: { type: ["string", "boolean", "number"] },
        },
      },
      required: ["fields"],
    },
    annotations,
    execute: async ({ fields }) => {
      const screen = activeScreen();
      if (!screen) return fail("No active screen. Call wizard_get_state.");
      if (!fields || typeof fields !== "object" || !Object.keys(fields).length) {
        return fail("`fields` must be a non-empty object keyed by data-agent-field names.");
      }

      const scope = scopeSelector(screen);
      const known = readFields(screen, scope);
      const unknown = Object.keys(fields).filter((k) => !known.some((f) => f.field === k));
      if (unknown.length) {
        return fail(`Unknown field(s): ${unknown.join(", ")}. Available: ${known.map((f) => f.field).join(", ") || "none"}.`);
      }

      const prev = signature();
      for (const [key, raw] of Object.entries(fields)) {
        const spec = known.find((f) => f.field === key);
        if (spec.disabled) return fail(`Field "${key}" is disabled.`);

        if (spec.type === "select") {
          await A().act.select(spec.selector, String(raw));
        } else if (spec.type === "checkbox") {
          const wanted = raw === true || raw === "true";
          if (spec.checked !== wanted) await A().act.click(spec.selector);
        } else if (spec.type === "radio") {
          await A().act.click(`${scope} [data-agent-field="${esc(key)}"][value="${esc(raw)}"]`);
        } else {
          await A().act.type(spec.selector, String(raw), { overwrite: true });
        }
        await delay(80); // let React commit between fields
      }

      await settle(prev, { timeout: 2000 }); // validation may or may not change anything
      return respond();
    },
  });

  browser.webfuseSession.registerTool({
    name: "wizard_navigate",
    description:
      "Press one of the form's navigation controls: next, back, submit or restart. Check wizard_get_state's `nav` "
      + "to see which are available on this screen. Waits for the form to settle and returns the resulting state.",
    inputSchema: {
      type: "object",
      properties: {
        control: { type: "string", enum: NAV_ROLES, description: "Which control to press." },
      },
      required: ["control"],
    },
    annotations,
    execute: async ({ control }) => {
      if (!NAV_ROLES.includes(control)) {
        return fail(`Unknown control "${control}". Use one of: ${NAV_ROLES.join(", ")}.`);
      }
      const screen = activeScreen();
      if (!screen) return fail("No active screen. Call wizard_get_state.");

      const found = navControl(screen, scopeSelector(screen), control);
      if (!found) return fail(`No "${control}" control on the "${screen.getAttribute("data-agent-step")}" screen.`);
      if (found.el.disabled) {
        return fail(`The "${control}" control is disabled — the screen probably needs an answer or a field filled first.`);
      }

      const prev = signature();
      await A().act.click(found.selector);
      await settle(prev);
      return respond();
    },
  });

  browser.webfuseSession.registerTool({
    name: "wizard_action",
    description:
      "Invoke a secondary action offered by the current screen — for example skipping an optional step or retrying "
      + "after a failure. Use the `value` from the `actions` list in wizard_get_state. Returns the resulting state.",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string", description: "The action's `value` from wizard_get_state." },
      },
      required: ["value"],
    },
    annotations,
    execute: async ({ value }) => {
      const screen = activeScreen();
      if (!screen) return fail("No active screen. Call wizard_get_state.");

      const actions = readActions(screen, scopeSelector(screen));
      if (!actions.length) {
        return fail(`The "${screen.getAttribute("data-agent-step")}" screen offers no actions.`);
      }
      const match = actions.find((a) => String(a.value) === String(value));
      if (!match) {
        return fail(`Unknown action "${value}". Available: ${actions.map((a) => a.value).join(", ")}.`);
      }
      if (match.disabled) return fail(`Action "${value}" is disabled.`);

      const prev = signature();
      await A().act.click(match.selector);
      await settle(prev);
      return respond();
    },
  });

  console.log("[wizard] registered 5 generic MCP tools");
}

registerTools();
