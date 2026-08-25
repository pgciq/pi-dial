# AGENTS.md

## Project overview

`pi-dial` is a TypeScript Pi provider extension for DIAL Core. The implementation is in `extensions/dial.ts` and registers the `dial` provider, discovers deployments from DIAL's `/openai/models` endpoint, and supports configured fallback deployments.

## Configuration

- `DIAL_BASE_URL`: DIAL Core base URL; defaults to `https://dialx.ai`.
- `DIAL_API_KEY`: API key sent in the `Api-Key` header.
- `DIAL_MODELS`: comma-separated fallback deployment names.
- `DIAL_MODEL`: single fallback deployment name.

## Development

Run the extension locally with:

```bash
pi -e ./extensions/dial.ts
```

The package has no build or test scripts. Keep changes focused on the provider behavior and preserve DIAL's deployment-specific URL format:

```text
/openai/deployments/{deployment_name}/chat/completions
```

When changing model metadata or request compatibility, verify the corresponding Pi provider/model fields against the Pi SDK's current API.
