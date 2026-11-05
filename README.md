# Becoming Mira – Avatar (Webfuse-extensie)

Dit is Mira's gezicht en handen in een Webfuse co-browse sessie. Het is een
Chrome-extensie (MV3) die Webfuse in de sessie laadt. Zelfde bouw als de
Jack-avatar, maar schoon voor Mira: geen gemeenten, geen VvE-formulieren.

## Hoe het samenhangt

- **Webfuse** = ogen en handen. Opent de site, leest de pagina, klikt en
  navigeert. Deze extensie draait in de sessie.
- **ElevenLabs** = oren, brein en stem. De agent denkt, praat en roept de
  tools aan (recall + de Webfuse Automation API als MCP-server).
- **Anam** = het gezicht. Toont Mira als bolletje en gebruikt de stem van
  ElevenLabs. De SDK zit in `anam.js`.
- **Supabase (Bestsellers)** = het geheugen. De agent haalt herinneringen op
  via `recall`.
- **Deze extensie** = de lijm. `popup.js` haalt een Anam-sessietoken op bij de
  site en start het bolletje; `content.js` levert de navigatietools aan Webfuse.

## Bestanden

| Bestand | Rol |
| --- | --- |
| `manifest.json` | De extensie: naam, rechten, tools, env-velden |
| `popup.html` | Het bolletje (navy met blauwe gloed) |
| `popup.js` | Haalt het Anam-token op bij de site en start het gesprek |
| `anam.js` | De Anam SDK (ongewijzigd) |
| `content.js` | Generieke navigatietools voor Webfuse (ongewijzigd) |
| `background.js` | Zet het popup-venster klein, rechtsonder |

## Instellen in Webfuse

Zet in Webfuse (space → extensie → env) twee waarden:

- `AVATAR_START_URL` → `https://becomingmira.com/api/avatar/webfuse-start`
- `AVATAR_SLEUTEL` → dezelfde waarde als `AVATAR_WEBFUSE_KEY` in Vercel

Geen sleutels in deze bestanden: die staan in Vercel en in Webfuse-env.
Daarom mag deze repo publiek zijn.

## Nog nodig voordat Mira praat

Deze extensie alleen laat nog geen pratende Mira zien. Nodig is:

1. De backend-route `POST /api/avatar/webfuse-start` op becomingmira.com, die
   een Anam-sessietoken teruggeeft (`{ "sessionToken": "..." }`).
2. De Anam-persona (Mira) en de ElevenLabs-agent gekoppeld aan die route.
3. De env-waarden in Vercel: Anam-key, ElevenLabs, `AVATAR_WEBFUSE_KEY`.

Stap 1–3 bouwen we als volgende stap in de becoming-mira site.
