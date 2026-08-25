// DIAL Core provider — https://dialx.ai/dial_api
//
// Required:
//   DIAL_API_KEY   API key (sent in the DIAL-specific Api-Key header)
// Optional:
//   DIAL_BASE_URL  DIAL Core URL, e.g. https://dial.example.com (no /openai suffix)
//   DIAL_MODELS    comma-separated deployment names used when model discovery is unavailable
//   DIAL_MODEL     one deployment name (fallback for DIAL_MODELS)
//
// DIAL exposes an OpenAI-compatible API, but uses deployment URLs:
//   /openai/deployments/{deployment_name}/chat/completions
// Model-level baseUrl is therefore set for every discovered deployment.

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

const DEFAULT_BASE_URL = "https://ai-proxy.lab.epam.com";
const PROVIDER_ID = "dial";

function cleanBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function deploymentUrl(baseUrl: string, id: string) {
  return `${baseUrl}/openai/deployments/${encodeURIComponent(id)}`;
}

function pricePerMillionTokens(value: unknown) {
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price * 1_000_000 : 0;
}

function modelFromItem(item: any, baseUrl: string) {
  const id = String(item?.id ?? item?.name ?? "");
  const limits = item?.limits ?? item?.capabilities ?? {};
  const pricing = item?.pricing ?? {};
  const contextWindow = Number(
    item?.context_window ?? item?.contextWindow ?? limits.maxTotalTokens ?? 128_000,
  );
  const maxTokens = Number(
    item?.max_tokens ?? item?.maxTokens ?? limits.maxCompletionTokens ?? Math.min(contextWindow, 16_384),
  );
  const supportsVision = item?.input_modalities?.includes?.("image") || item?.vision === true;
  const reasoning = item?.reasoning === true || item?.supports_reasoning === true;

  return {
    id,
    name: item?.display_name ?? item?.displayName ?? item?.name ?? id,
    api: "openai-completions",
    baseUrl: deploymentUrl(baseUrl, id),
    reasoning,
    input: supportsVision ? ["text", "image"] : ["text"],
    // DIAL reports USD per token; Pi model costs are USD per million tokens.
    cost: {
      input: pricePerMillionTokens(pricing.prompt),
      output: pricePerMillionTokens(pricing.completion),
      cacheRead: pricePerMillionTokens(pricing.cache_read ?? pricing.cacheRead),
      cacheWrite: pricePerMillionTokens(pricing.cache_write ?? pricing.cacheWrite),
    },
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128_000,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 16_384,
    compat: {
      // DIAL's documented API supports max_tokens, not max_completion_tokens.
      maxTokensField: "max_tokens",
      supportsDeveloperRole: false,
      supportsStore: false,
    },
  };
}

function fallbackModels(baseUrl: string) {
  const configured = process.env.DIAL_MODELS || process.env.DIAL_MODEL || "";
  return configured
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => modelFromItem({ id }, baseUrl));
}

async function discoverModels(baseUrl: string, apiKey: string) {
  const response = await fetch(`${baseUrl}/openai/models`, {
    headers: { "Api-Key": apiKey },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const payload: any = await response.json();
  const items = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return items
    .map((item) => modelFromItem(item, baseUrl))
    .filter((model) => model.id);
}

export default async function (pi) {
  const baseUrl = cleanBaseUrl(process.env.DIAL_BASE_URL || DEFAULT_BASE_URL);
  const apiKey = process.env.DIAL_API_KEY || "";
  let models = fallbackModels(baseUrl);

  if (apiKey) {
    try {
      const discovered = await discoverModels(baseUrl, apiKey);
      if (discovered.length > 0) models = discovered;
    } catch (error) {
      console.error(`[dial] Model discovery failed (${error instanceof Error ? error.message : String(error)}). Using DIAL_MODELS/DIAL_MODEL.`);
    }
  } else {
    console.error("[dial] DIAL_API_KEY is not set. Set it before selecting a dial/* model.");
  }

  pi.registerProvider(PROVIDER_ID, {
    name: "DIAL",
    // The actual endpoint is model-specific; this value is used only as a fallback.
    baseUrl: `${baseUrl}/openai/deployments`,
    api: "openai-completions",
    apiKey: "$DIAL_API_KEY",
    headers: { "Api-Key": "$DIAL_API_KEY" },
    models,
  });

  registerPricesCommand(pi);
  registerUsageStatusBar(pi);
}

const DIAL_USAGE_STATUS_KEY = "dial-usage";

function formatMoney(value: number) {
  return `$${value.toFixed(6)}`;
}

function formatTokens(value: number) {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}K`
      : String(value);
}

function usageCost(usage: any) {
  const cost = usage?.cost ?? {};
  return {
    input: Number(cost.input) || 0,
    output: Number(cost.output) || 0,
    cacheRead: Number(cost.cacheRead) || 0,
    cacheWrite: Number(cost.cacheWrite) || 0,
  };
}

function totalCost(cost: ReturnType<typeof usageCost>) {
  return cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
}

function registerUsageStatusBar(pi) {
  let sessionCost = 0;
  let sessionTokens = 0;

  pi.on("session_start", async (_event, ctx) => {
    sessionCost = 0;
    sessionTokens = 0;
    ctx.ui.setStatus(DIAL_USAGE_STATUS_KEY, undefined);
  });

  pi.on("turn_end", async (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID || !event.message?.usage) return;

    const usage = event.message.usage;
    const cost = usageCost(usage);
    const currentCost = totalCost(cost);
    const tokens = Number(usage.totalTokens) || 0;
    sessionCost += currentCost;
    sessionTokens += tokens;

    const text = `💰 ${formatMoney(currentCost)} | ${formatTokens(tokens)} tokens | session ${formatMoney(sessionCost)} / ${formatTokens(sessionTokens)} tokens`;
    ctx.ui.setStatus(DIAL_USAGE_STATUS_KEY, text);
  });

  pi.on("model_select", async (event, ctx) => {
    if (event.model?.provider !== PROVIDER_ID) {
      ctx.ui.setStatus(DIAL_USAGE_STATUS_KEY, undefined);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(DIAL_USAGE_STATUS_KEY, undefined);
  });
}

function registerPricesCommand(pi) {
  const sortKeys = { input: "input", output: "output", total: "total", context: "contextWindow" };

  pi.registerCommand("dial-prices", {
    description: "List DIAL model prices per 1M tokens; e.g. /dial-prices output desc",
    handler: async (args, ctx) => {
      const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
      const sortArg = tokens.find((token) => token in sortKeys) || "total";
      const desc = tokens.includes("desc");
      const sortKey = sortKeys[sortArg];
      const models = ctx.modelRegistry.getAvailable().filter((model) => model.provider === PROVIDER_ID);

      const rows = models
        .map((model) => ({
          id: model.id,
          input: model.cost?.input ?? 0,
          output: model.cost?.output ?? 0,
          total: (model.cost?.input ?? 0) + (model.cost?.output ?? 0),
          contextWindow: model.contextWindow ?? 0,
        }))
        .sort((a, b) => (desc ? b[sortKey] - a[sortKey] : a[sortKey] - b[sortKey]));

      const markdown = [
        `# DIAL model prices (USD per 1M tokens, sorted by ${sortArg}${desc ? " desc" : " asc"})`,
        "",
        "| Model | Input | Output | Total | Context |",
        "|---|---:|---:|---:|---:|",
        ...rows.map((row) =>
          `| ${row.id} | ${formatMoney(row.input)} | ${formatMoney(row.output)} | ${formatMoney(row.total)} | ${formatTokens(row.contextWindow)} |`,
        ),
      ].join("\n");

      if (ctx.mode === "tui") {
        pi.appendEntry("dial-prices", { markdown });
      } else if (ctx.hasUI) {
        ctx.ui.notify(markdown, "info");
      } else {
        console.log(markdown);
      }
    },
  });

  pi.registerEntryRenderer("dial-prices", (entry) => {
    const mdTheme = getMarkdownTheme();
    return new Markdown(entry.data.markdown, 1, 0, mdTheme);
  });
}
