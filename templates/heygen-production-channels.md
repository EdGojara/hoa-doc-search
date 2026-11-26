# HeyGen production channels (Media Studio operating policy)

> Ed 2026-11-26. Permanent policy. Read before rendering any HeyGen video.

Bedrock produces HeyGen video through **two separate channels**. Each has its own
billing and its own rules. Choose the channel before every render.

## 1. Subscription channel: hand-directed creative work

**How:** HeyGen MCP (`https://mcp.heygen.com/mcp/v1/`, OAuth sign-in to Bedrock's
subscribed HeyGen account from a supported AI app such as Claude), or HeyGen
Studio on the web.

**Use for:**
- Amanda's scripted videos and social content
- cinematic scenes and storytelling
- creative series content
- multi-character productions (Amanda, Phoebe, Paige and other teammates)
- experimentation, rehearsals and retakes

**Bills to:** the monthly subscription credits. Use the subscription instead of
the API wallet whenever it supports the production.

## 2. Direct API channel: automated production

**How:** `lib/video/heygen.js` with `HEYGEN_API_KEY`. Billed to the pay-as-you-go
API wallet.

**Use for:**
- Media Studio Generate (`api/video_share.js`: `/generate`, `/generate-status/:token`)
- association communications and explainers (`api/claire.js` explainer create and poll, `/learn`)
- `scripts/render_explainer.js`
- any scheduled or system-generated video
- automated rendering, status polling, and the copy to Supabase storage

## Hard rules

- **Never route automation through the subscription.** HeyGen's MCP sign-in works only from supported AI apps, for the account owner's own use. HeyGen rejects apps, gateways and automation tools. Subscription credits may not power automation. Do not proxy MCP through the server, run it headless or on a schedule, or share the login.
- **Before every render, state:**
  - the channel
  - the engine (Avatar IV is HeyGen's default when `engine` is omitted, and it is what `renderExplainer` gets today; Avatar V or 6 only on purpose)
  - the teammate's approved identity (`node scripts/character_identity.js <persona>`)
  - the estimated credits or dollars, using HeyGen's published rates

  On the subscription channel, check remaining and rollover credits first (MCP `get_current_user`).
- **Never silently fall back to the API** when the subscription could do the job. If credits are short or a feature isn't on the plan, ask Ed.
- **No duplicate renders.** Check the `/learn` library and Media Studio first. Lock and rehearse the script before rendering (see `templates/ai-team-video-script.md`).
- **Needs Ed's OK:** buying credits, changing plans, or paid test renders.
- **Track separately:** subscription credits and API wallet spend are separate usage lines. Never combine them in reporting.

## Character identity (Ed 2026-11-26, permanent)

**One character. One identity. One voice. One personality. Multiple approved appearance variations.**

The Character Canon (`lib/characters/registry.js`, admin page `/admin/characters`) is the only source of a teammate's current approved face, look, voice and personality. `lib/characters/production.js` resolves it from the character's **current release**:

- **Face:** the approved face version in the current release.
- **Production look:** exactly one active HeyGen look on channel `video`, built from that face. Other approved looks of the same face are on channel `video_variant` and are used only when named on purpose.
- **Voice:** the approved voice version in the current release, spoken by its **ElevenLabs** voice (the canonical voice provider). HeyGen library voices are never canonical.
- **Personality:** the approved persona version in the current release.

**Automated renders (API)** resolve all of this in code (`renderExplainer`). The script is spoken in the canonical ElevenLabs voice, the audio is uploaded, and HeyGen lip-syncs the production look to it. `<FACE>_AVATAR_ID` and `<FACE>_VOICE_ID` env values are no longer read for renders. If the face, look or voice is unapproved or missing, the render **stops** with the reason (HTTP 409 `identity_not_approved`) and nothing is sent to HeyGen.

**Hand productions (MCP or Studio)** must follow the same rule. Before rendering, run:

```
node scripts/character_identity.js <persona>
```

Use only the look IDs it prints. Speak in the teammate's canonical voice by generating the audio with her ElevenLabs voice and passing it to HeyGen as audio (MCP `audioUrl` / `audioAssetId`, or Studio's audio upload). If the script reports a missing or unapproved piece, stop and ask Ed.

**Never** fall back to a superseded face, an older look, an unapproved candidate, a stock voice, another teammate's voice, or an outdated personality. Superseded faces and looks are kept in the Canon as history (rejected or retired) and are ineligible for new work. Old videos are archived, never deleted (`claire_explainers.status = 'retired'`).

## Getting subscription videos into the library

HeyGen video links expire in about a week. Every finished subscription video must
be stored in our own storage before it is linked anywhere.

- **Today, no code change:** download the MP4 from the MCP `get_video` result and upload it through Media Studio's existing upload path.
- **Possible later (needs Ed's OK):** an admin "import by HeyGen video ID" action that reuses the existing copy-to-storage code. It works only if the API key can read videos made in the same account through MCP or Studio. That is not yet verified.
