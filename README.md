# pi-dial

Pi provider extension for [DIAL Core](https://dialx.ai/dial_api).

## Configuration

```bash
export DIAL_BASE_URL="https://your-dial-core.example.com"
export DIAL_API_KEY="your-api-key"
```

The extension discovers deployment names from `GET /openai/models`. DIAL requests use the documented deployment endpoint:

```text
/openai/deployments/{deployment_name}/chat/completions
```

Use a discovered deployment in pi:

```bash
pi --model dial/<deployment-name>
```

If model discovery is unavailable, specify fallback deployment names:

```bash
export DIAL_MODELS="gpt-4o,claude-sonnet-4"
# or a single deployment:
export DIAL_MODEL="gpt-4o"
```

The API key is sent in the DIAL-specific `Api-Key` header. Model IDs are deployment names returned by DIAL and may differ from the upstream model names.

## Startup & model discovery (non-blocking)

The provider registers immediately with the seed/fallback list (`DIAL_MODELS` / `DIAL_MODEL`, or empty) so pi is usable the instant the extension loads — it never blocks startup waiting for `GET /openai/models`.

Live model discovery runs **in the background** via pi's `refreshModels` callback:

- pi's cache-only startup phase (or a cancelled refresh) returns the already-known list without touching the network.
- When network is allowed, `GET /openai/models` is fetched with an 8s per-request timeout; on success the discovered list is persisted to pi's provider cache (`publish({ persist })`) and hot-swaps the catalog.
- On failure it keeps the previous list, so the user is never left without models.

`DIAL_API_KEY` is required for discovery; without it (or with `DIAL_MODELS` set) the seed list is used directly.

**About large catalogs (100+ deployments):** discovery is a *single* `GET /openai/models` call — all deployments arrive in one response, so it is one fast, 8s-capped request, not 100 sequential ones. On the **first** run with no cache the catalog fills in that one background call; the result is then persisted to pi's provider cache, so **every subsequent start shows all 100+ models instantly** (from cache) and only re-validates in the background. If you pick a `dial/*` model in the brief first-run window before discovery finishes, set `DIAL_MODELS` for your common deployments (instant, no network needed) or just run `/reload` a moment later.

## Per-model capabilities (vision / image / video)

Each deployment is registered with the capabilities DIAL actually reports for it, read from the model item's `type`, `features`, `capabilities`, and `input_modalities` / `output_modalities`. The catalog entry carries:

- `reasoning` — extended-thinking models.
- `input: ["text", "image"]` — vision-capable deployments accept images as input.
- a `capabilities` block (`tools`, `vision`, `image`, `video`, `audio`, `reasoning`) surfaced in `/list-models`.

At request time a single provider-level `streamSimple` inspects these flags and routes to the right endpoint:

- **Chat / completion deployments** → `POST /openai/deployments/{name}/chat/completions` (OpenAI completions).
- **Image-generation deployments** (`type: "image"`, or `image` in `output_modalities`/`capabilities`/`features`) → `POST /openai/images/generations` (or `/openai/images/edits` when the prompt includes reference images). The generated image is saved under `.pi/generated-images/` and its URL is returned.
- **Video-generation deployments** → `POST /openai/videos/generations` (best-effort; DIAL's video endpoint shape varies — adjust the endpoint/body if your instance differs).
- Non-chat, non-image, non-video deployments (embedding/moderation/audio/…) are registered for visibility but return a clear “not streamed by this extension” error if selected.

So, for example, `pi --model dial/<image-deployment>` generates an image, while `pi --model dial/<vision-deployment>` can be shown images inline.

## Commands

- `/dial-prices [input|output|total|context] [desc]` — list DIAL model prices per 1M tokens (sorted; `desc` reverses).
- `/dial-capabilities [image|video|audio|vision|reasoning|tools]` — list each deployment's capabilities (vision / image / video / audio / tools / reasoning). An optional filter narrows the table to deployments that support that capability, e.g. `/dial-capabilities image` shows only image-generation deployments.

## Install locally

From this directory:

```bash
pi -e ./extensions/dial.ts
```

Or add this directory/package to your pi configuration.
