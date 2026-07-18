import { CMD_SYS, IMPORT_SCHEMA, STYLE_SCHEMA, STYLE_RULES, TAILOR_SYS } from "./prompts.js";

/* ═══════════════════════════════════════════════════════════════
   THE ACTION CATALOG

   The single most important idea in this whole backend.

   Today the browser sends { model, max_tokens, system, messages } and
   api/claude.js forwards it. That means the request body IS the API call.
   Auth alone does not fix this: a user who paid 189 rupees could open
   devtools and POST { model:"claude-opus-4-8", max_tokens:8000,
   system:"You are a helpful assistant", messages:[...] } and spend your
   money on their homework, forever, for 189 rupees.

   So: the client sends { action, payload }. The server owns the model,
   the max_tokens, the system prompt, and the shape of the user message.
   The payload is data, and it is length-capped. There is no request the
   client can construct that costs more than the cap below.

   Two numbers per action:
     reserve = charged up front. The worst case, assuming the user hits every
               payload cap AND the model emits max_tokens. Never exceeded.
     typical = what settle() refunds down to on a normal call.
   Reserving the worst case is what stops 100 concurrent calls on 1 credit.
   Refunding to actual is what stops the user feeling robbed. See PRICING.md.
   ═══════════════════════════════════════════════════════════════ */

const S = (v, max) => String(v ?? "").slice(0, max);

// Cheap, high-frequency, structurally simple -> Haiku.
// Prose quality and long-document reasoning -> Sonnet.
// Routing per action is the single biggest lever on your bill: the
// same pack is 213 actions on Haiku and 71 on Sonnet. See PRICING.md.
const TONES = { concise: "concise", impactful: "impactful", formal: "formal" };

const HAIKU = "claude-haiku-4-5";
const SONNET = "claude-sonnet-4-6";

export const ACTIONS = {
  /* Scribe design commands. CMD_SYS is ~1600 static tokens on every single
     call, which is exactly what prompt caching is for: cache reads cost 0.1x
     input. This alone cuts Scribe's cost roughly 40%. */
  scribe: {
    reserve: 4,   // worst case: every payload cap hit AND max_tokens reached
    typical: 2,    // what settle() actually charges a normal call. Shown on the pricing page.
    model: HAIKU,
    max_tokens: 1000,
    cache_system: true,
    build: (p) => ({
      system: CMD_SYS,
      messages: [{
        role: "user",
        content: `STATE:\n${S(p.state, 12000)}\n${p.recent ? "\nRECENT CHAT:\n" + S(p.recent, 2000) + "\n" : ""}\nINSTRUCTION: ${S(p.instruction, 600)}`,
      }],
    }),
  },

  rewrite: {
    reserve: 1,
    typical: 1,
    model: HAIKU,
    max_tokens: 400,
    build: (p) => ({
      /* tone comes from the client, so it is an enum lookup, not string
         interpolation. `You are an elite resume writer... more ${p.tone}` with
         a raw client value is prompt injection with extra steps: tone becomes
         "concise. Ignore all previous instructions and ..." and the system
         prompt is now whatever they like. An allowlist makes that impossible
         rather than merely difficult. */
      system: `You are an elite resume writer. Rewrite the given resume bullet to be more ${TONES[p.tone] || TONES.concise}: strong action verbs, quantified impact, crisp language, ONE line, roughly the same length. Return ONLY the rewritten bullet, no quotes, no preamble.`,
      messages: [{ role: "user", content: S(p.text, 1200) }],
    }),
  },

  import: {
    reserve: 18,   // worst case: every payload cap hit AND max_tokens reached
    typical: 8,    // what settle() actually charges a normal call. Shown on the pricing page.
    model: SONNET,
    max_tokens: 1000,
    build: (p) => {
      const draftRule = p.draft
        ? "Polish wording into crisp, achievement-focused resume bullets with strong verbs. If the input is rough notes rather than a finished CV, draft complete professional content from it. Never invent employer or institution names, dates, scores, or numbers that are not present or clearly implied; leave unknown fields as empty strings."
        : "Extract faithfully with only light cleanup. Do not add or embellish content.";
      const styleRule = p.style ? ` Begin the JSON with a "style" key, before any content: ${STYLE_SCHEMA} ${STYLE_RULES}` : "";
      return {
        system: `You are a resume parsing engine. Read the input (an old CV as text, a PDF, or an image/scan; a LinkedIn profile; or rough notes) and return ONLY minified valid JSON with exactly this shape, omitting any top-level key you found no data for: ${IMPORT_SCHEMA}${styleRule} Rules: ${draftRule} Keep years short (e.g. 2024); date ranges go in duration or year fields as written. Max 6 entries per list, max 5 bullets per entry, each bullet under 25 words. tag is an optional 2-4 word theme for that experience. Output raw JSON only: no markdown, no code fences, no commentary.`,
        messages: [{ role: "user", content: contentBlocks(p.content) }],
      };
    },
    counts_upload: true,
  },

  steal_look: {
    reserve: 15,   // worst case: every payload cap hit AND max_tokens reached
    typical: 4,    // what settle() actually charges a normal call. Shown on the pricing page.
    model: SONNET,
    max_tokens: 400,
    build: (p) => ({
      system: `You are a document style analyst. Look at the uploaded CV and return ONLY minified valid JSON in exactly this shape: ${STYLE_SCHEMA} ${STYLE_RULES} Ignore the document's content entirely; never return names, employers, or any text from it. Output raw JSON only: no markdown, no commentary.`,
      messages: [{ role: "user", content: contentBlocks(p.content) }],
    }),
    counts_upload: true,
  },

  cover_letter: {
    reserve: 13,   // worst case: every payload cap hit AND max_tokens reached
    typical: 9,    // what settle() actually charges a normal call. Shown on the pricing page.
    model: SONNET,
    max_tokens: 1000,
    build: (p) => ({
      system: "You write concise, confident cover letters. Use ONLY facts present in the resume; never invent employers, dates, or numbers. 250-330 words, 3-4 short paragraphs, no address block, no subject line, start at the salutation and end after the sign-off name. Plain text only, blank line between paragraphs.",
      messages: [{
        role: "user",
        content: "RESUME:\n" + S(p.resume, 14000) +
          (p.jd ? "\n\nJOB DESCRIPTION:\n" + S(p.jd, 6000)
                : "\n\n(No job description supplied; write a strong general-purpose letter for this candidate's obvious target roles.)"),
      }],
    }),
  },

  tailor: {
    reserve: 14,
    typical: 10,
    model: SONNET,
    max_tokens: 1000,
    build: (p) => ({
      /* Earlier draft of this file had `system: S(p.system, 4000)`, letting the
         client send its own system prompt. That is the entire vulnerability
         this catalog exists to close, dressed up as a length cap. The prompt
         lives on the server or it does not live at all. */
      system: TAILOR_SYS,
      messages: [{
        role: "user",
        content: `JOB DESCRIPTION:\n${S(p.jd, 6000)}\n\nRESUME BULLETS:\n${S(p.bullets, 8000)}\n\nRESUME SKILLS: ${S(p.skills, 600) || "(none listed)"}`,
      }],
    }),
  },
};

/* Uploads are the one place the client sends bytes. An image or PDF page is
   roughly 1600 input tokens, and a 40-page PDF is 64k tokens on ONE call.
   Cap the payload here, not in the React file: the React file is advisory. */
function contentBlocks(content) {
  if (typeof content === "string") return content.slice(0, 40000);
  if (!Array.isArray(content)) throw new BadPayload("content must be a string or block array");
  if (content.length > 6) throw new BadPayload("Too many pages. Upload up to 6 at a time.");
  return content.map((b) => {
    if (b.type === "text") return { type: "text", text: String(b.text).slice(0, 40000) };
    if (b.type === "image" || b.type === "document") {
      const data = b.source?.data ?? "";
      // 6 MB of base64 is ~4.5 MB of file. Anything bigger is not a CV.
      if (typeof data !== "string" || data.length > 6_000_000) throw new BadPayload("File too large.");
      const mt = String(b.source?.media_type ?? "");
      const allowed = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];
      if (!allowed.includes(mt)) throw new BadPayload("Unsupported file type.");
      return { type: b.type, source: { type: "base64", media_type: mt, data } };
    }
    throw new BadPayload("Unsupported content block.");
  });
}

export class BadPayload extends Error {}
