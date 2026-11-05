// Must match the values set in background.js
var popupBottom = 30;
var popupRight = 30;

// ---------------------------------------------------------------------------
// Becoming Mira — avatar-venster.
// In plaats van de ElevenLabs-widget toont dit venster Mira als bolletje met
// het gezicht van Anam. Het denkwerk, de stem en de tools blijven bij de
// ElevenLabs-agent (met de Webfuse Automation API als MCP-server), dus kijken
// en navigeren op becomingmira.com werken via dezelfde tools.
//
// Instellingen in de extensie (Webfuse > space > extensie > env):
//   AVATAR_START_URL  https://becomingmira.com/api/avatar/webfuse-start
//   AVATAR_SLEUTEL    zelfde waarde als AVATAR_WEBFUSE_KEY in Vercel
// Mira kent geen gemeenten/tenants: de start-call stuurt alleen de sleutel en
// het sessie-id mee.
// ---------------------------------------------------------------------------

var KLEIN = { w: 230, h: 260 };   // venster met het bolletje en de knoppen
var GROOT = { w: 380, h: 520 };   // venster met Mira groot in beeld

function zetMaat(m) {
  try { browser.browserAction.resizePopup(m.w, m.h); } catch (e) { /* oude runtime */ }
  setTimeout(function () {
    console.log("[mira-avatar] venster gevraagd", m.w + "x" + m.h, "werkelijk", window.innerWidth + "x" + window.innerHeight);
  }, 400);
}

function toon(tekst, fout) {
  var el = document.getElementById("melding");
  el.textContent = tekst || "";
  el.style.display = tekst ? "block" : "none";
  el.className = fout ? "fout" : "";
}

async function init() {
  zetMaat(KLEIN);
  initDrag();

  const sessionInfo = await browser.webfuseSession.getSessionInfo();
  const env = browser.webfuseSession.env || {};
  console.log("[mira-avatar] sessie", sessionInfo && sessionInfo.sessionId);

  const bol = document.getElementById("bol");
  const knoppen = document.getElementById("knoppen");
  const label = document.getElementById("bol-label");
  let token = null;
  let client = null;
  let groot = false;

  async function haalToken() {
    token = null;
    label.textContent = "…";
    if (!env.AVATAR_START_URL || !env.AVATAR_SLEUTEL) {
      toon("AVATAR_START_URL of AVATAR_SLEUTEL ontbreekt in de extensie.", true);
      label.textContent = "Mira";
      return;
    }
    try {
      const r = await fetch(env.AVATAR_START_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sleutel: env.AVATAR_SLEUTEL, webfuse_sessie: sessionInfo.sessionId }),
      });
      const j = await r.json().catch(function () { return {}; });
      if (!r.ok || !j.sessionToken) { toon(j.fout || "Mira kon niet worden voorbereid.", true); label.textContent = "Opnieuw"; return; }
      token = j.sessionToken;
      label.textContent = "Mira";
      toon("");
    } catch (e) {
      console.warn("[mira-avatar] start niet bereikbaar", e);
      toon("De site is niet bereikbaar.", true);
      label.textContent = "Opnieuw";
    }
  }

  function zetGroot(aan) {
    groot = aan;
    document.body.classList.toggle("groot", aan);
    document.getElementById("groter").textContent = aan ? "Kleiner" : "Groter";
    zetMaat(aan ? GROOT : KLEIN);
  }

  async function start() {
    if (client) { zetGroot(!groot); return; }
    if (!token) { await haalToken(); return; }
    try {
      document.body.classList.add("verbinden");
      client = AnamSDK.createClient(token);
      token = null; // een token is voor één gesprek
      client.addListener(AnamSDK.AnamEvent.VIDEO_PLAY_STARTED, function () {
        document.body.classList.remove("verbinden");
        document.body.classList.add("bezig");
        knoppen.style.display = "flex";
      });
      client.addListener(AnamSDK.AnamEvent.CONNECTION_CLOSED, function (reden, details) {
        console.warn("[mira-avatar] gesloten", reden, details);
        var kort = String(reden).replace("CONNECTION_CLOSED_CODE_", "");
        if (kort !== "NORMAL") toon("Gesprek gestopt (" + kort + ")" + (details ? ": " + details : "") + ".", true);
        klaar();
      });
      await client.streamToVideoElement("avatar-video");
    } catch (e) {
      console.error("[mira-avatar] starten mislukt", e);
      toon("Starten lukte niet. Sta de microfoon toe en probeer opnieuw.", true);
      klaar();
    }
  }

  function klaar() {
    client = null;
    document.body.classList.remove("verbinden", "bezig");
    knoppen.style.display = "none";
    zetGroot(false);
    haalToken();
  }

  async function stop() {
    var c = client;
    client = null;
    try { if (c) await c.stopStreaming(); } catch (e) { /* al dicht */ }
    klaar();
  }

  bol.addEventListener("click", start);
  bol.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); start(); } });
  document.getElementById("groter").addEventListener("click", function () { zetGroot(!groot); });
  document.getElementById("stop").addEventListener("click", stop);

  await haalToken();
}

function initDrag() {
  const handle = document.getElementById("drag-handle");
  let dragging = false;
  let startX, startY, snapBottom, snapRight;
  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.screenX; startY = e.screenY;
    snapBottom = popupBottom; snapRight = popupRight;
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    popupBottom = snapBottom - (e.screenY - startY);
    popupRight = snapRight - (e.screenX - startX);
    browser.browserAction.setPopupPosition({ bottom: popupBottom + "px", right: popupRight + "px" });
  });
  window.addEventListener("mouseup", () => { dragging = false; });
}

document.addEventListener("DOMContentLoaded", init);
