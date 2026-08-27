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

## What DIAL Core exposes (capabilities)

This extension targets **DIAL Core** (`epam/ai-dial-core`). Per its OpenAPI spec the catalog API (`GET /openai/models`) returns deployments whose `ModelType` is only `CHAT` / `COMPLETION` / `EMBEDDING`, with a `capabilities` object of booleans (`chat_completion`, `completions`, `embeddings`, `fine_tune`, `inference`) and — for chat deployments — `input_attachment_types` (e.g. `image/*`). **DIAL Core has no image-generation or video-generation endpoint**, so this extension does **not** implement image/video generation routing (the capability flags for those stay `false`).

Each deployment is registered with the capabilities DIAL actually reports, read from the model item's `type` / `ModelType`, `capabilities`, `input_attachment_types`, and `input_modalities` / `output_modalities` (the detection tolerates all of these schema variants). The catalog entry carries:

- `reasoning` — extended-thinking models (reported via `reasoning`/`supports_reasoning`/`reasoning_effort`).
- `input: ["text"]` or `input: ["text", "image"]` — vision-capable deployments accept images as input (from `input_attachment_types` / `input_modalities`).
- a `capabilities` block (`tools` ← `chat_completion`, `vision` ← image input, `image`, `video`, `audio`, `reasoning`) surfaced in `/list-models`.
- `display_name` is read from the `{ plainValue: "…" }` object DIAL returns.

At request time a single provider-level `streamSimple` routes only chat deployments to `POST /openai/deployments/{name}/chat/completions` (OpenAI completions). Non-chat deployments (embedding/…) are registered for visibility but return a clear “not streamed by this extension” error if selected.

So `pi --model dial/<vision-deployment>` can be shown images inline, while image/video *generation* is not supported by DIAL Core and is therefore not routed.

## Commands

- `/dial-prices [input|output|total|context] [desc]` — list DIAL model prices per 1M tokens (sorted; `desc` reverses).
- `/dial-capabilities [image|video|audio|vision|reasoning|tools]` — list each deployment's capabilities (vision / image / video / audio / tools / reasoning). An optional filter narrows the table to deployments that support that capability, e.g. `/dial-capabilities vision` shows only vision-capable deployments.

## Install locally

From this directory:

```bash
pi -e ./extensions/dial.ts
```

Or add this directory/package to your pi configuration.
