# Shortlist

A CV builder — import an old resume, tailor it to a job, export a PDF.

## Run locally

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Deploy to Vercel

**Option A — from the dashboard**

1. Push this folder to a GitHub repo.
2. On vercel.com: **Add New → Project**, import the repo.
3. Vercel detects Vite automatically. Leave the defaults:
   - Framework preset: **Vite**
   - Build command: `npm run build`
   - Output directory: `dist`
4. **Deploy.**

**Option B — from the CLI**

```bash
npm i -g vercel
vercel          # preview deploy
vercel --prod   # production
```

No environment variables are needed. There is no backend.

## What works without any AI

Scribe never edited the CV with a model. It only translated your sentence into
an `ops` list, and `applyOps()` — ordinary local code — did the work. So every
mechanical instruction is parsed by rules in `localCommand()`, with no network:

- sizes: "bigger text", "smaller name", "headings bigger", "text 110%"
- colour: "accent navy", "green accent", "#14532d", "monochrome off"
- layout: "wider margins", "margins 18mm", "tighter line spacing"
- page: "make it a4", "ivory paper", "use a serif font"
- sections: "move skills up", "education to the top", "hide competitions",
  "rename skills to Core Strengths"
- templates: "use the vertex template"
- app: "fit to one page", "undo", "reset design"

These are instant, free, work with the network unplugged, and cannot hallucinate
an op. No key required.

**What still needs a model**, because pattern-matching cannot honestly fake
writing prose:

| Feature | Offline? |
|---|---|
| Scribe design/layout commands | Yes |
| Rewrite a bullet | No |
| Smart Import (parse an old CV) | No |
| Cover letter draft | No |
| Copy the look from a PDF/screenshot | No (needs vision) |
| Tailor rewrite suggestions | No |

If the model is unreachable, Scribe says which commands still work rather than
failing silently.

## AI features need a server-side key

The browser cannot call `api.anthropic.com` directly: the request is
CORS-blocked, and putting a key in client code exposes it to anyone who opens
devtools. So AI calls go to `/api/claude` (see `api/claude.js`), which adds the
key server-side.

In Vercel: **Settings → Environment Variables**, add `ANTHROPIC_API_KEY`, then
**redeploy** (env vars are applied at build time).

If your proxy lives at a different route, either rename `api/claude.js` or set
the override in `index.html` before the app script:

```html
<script>window.__AI_ENDPOINT__ = "/api/your-route";</script>
```

Inside the Claude artifact sandbox the host injects the key, so the app calls
Anthropic directly and this proxy is bypassed. `AI_ENDPOINT` at the top of
`src/CVBuilder.jsx` handles that switch automatically.

## How data is stored

Everything lives in the browser. There is no server and no database, so a CV
never leaves the visitor's machine.

Storage goes through `window.storage`. Inside the Claude artifact sandbox that
object is injected by the host. Everywhere else — including Vercel — it does not
exist, so `src/CVBuilder.jsx` installs a `localStorage`-backed adapter with the
same async contract at module load. That adapter is what makes the sign-up
screen and autosave work off-platform.

Practical consequences:

- Data is **per-browser and per-device**. It does not sync.
- Clearing site data clears the CVs. Use **Versions → Download backup** to get a
  JSON file, and **Restore backup** to bring it back.
- Private/incognito windows may block storage. The adapter detects this and
  steps aside rather than throwing, and the app falls back to guest mode.
- `localStorage` caps around 5 MB per origin. That is plenty for text, but many
  large embedded photos could hit it.

## Notes

- The bundle is ~2.1 MB (~1.4 MB gzipped). Most of that is base64 imagery
  embedded directly in the component, which is why the chunk-size warning is
  raised in `vite.config.js`.
- `vercel.json` rewrites all routes to `/` because this is a single-page app
  with client-side view state.
