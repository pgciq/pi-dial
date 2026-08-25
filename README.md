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

## Install locally

From this directory:

```bash
pi -e ./extensions/dial.ts
```

Or add this directory/package to your pi configuration.
