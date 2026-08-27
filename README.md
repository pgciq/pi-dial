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

## Install locally

From this directory:

```bash
pi -e ./extensions/dial.ts
```

Or add this directory/package to your pi configuration.
