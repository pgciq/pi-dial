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
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// `openAICompletionsApi` lives on the bare `@earendil-works/pi-ai` export in
// older pi-ai builds but moved to the `@earendil-works/pi-ai/api/openai-completions.lazy`
// subpath in newer ones. Resolve it defensively so the extension loads on both.
const openAICompletionsApi = await (async () => {
  try {
    return (await import("@earendil-works/pi-ai/api/openai-completions.lazy")).openAICompletionsApi;
  } catch {
    return (await import("@earendil-works/pi-ai")).openAICompletionsApi;
  }
})();

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

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/[,\s]+/).filter(Boolean);
  return [];
}

// DIAL model items advertise capabilities in several shapes depending on the
// upstream model: a top-level `type` ("chat" | "image" | "video" | "embedding"
// | "audio" | "moderation" | ...), a `features` array/object, and/or a
// `capabilities` map whose present keys describe what the deployment can do,
// plus `input_modalities` / `output_modalities` arrays. Normalize all of them
// into a single capability descriptor so each registered model reflects its
// real abilities (vision input, image/video generation, audio, tools, reasoning).
function detectCapabilities(item: any) {
  const type = String(item?.type ?? item?.model_type ?? item?.kind ?? "").toLowerCase();
  const rawFeatures = item?.features;
  const featureSet = new Set<string>(
    Array.isArray(rawFeatures)
      ? rawFeatures.map(String)
      : rawFeatures && typeof rawFeatures === "object"
        ? Object.keys(rawFeatures).filter((key) => rawFeatures[key])
        : [],
  );
  const capsObj = item?.capabilities ?? {};
  const capKeys = Object.keys(capsObj).filter((key) => capsObj[key]);
  const inputModalities = asArray(item?.input_modalities ?? item?.architecture?.inputModalities ?? capsObj?.input_modalities);
  const outputModalities = asArray(item?.output_modalities ?? item?.architecture?.outputModalities ?? capsObj?.output_modalities);

  // NOTE: capabilities are matched only against type/features/capabilities —
  // NOT against input/output modalities, because a modality like "image" in
  // input_modalities means *vision* (image input), while in output_modalities
  // it means *image generation*. Those are handled separately below.
  const flag = (...names: string[]) =>
    names.some(
      (name) =>
        type === name ||
        featureSet.has(name) ||
        capKeys.includes(name) ||
        capsObj?.[name] === true ||
        (Array.isArray(capsObj?.[name]) ? capsObj[name].length > 0 : false),
    );

  const attachmentTypes = asArray(item?.input_attachment_types);
  const supportsImageInput =
    flag("vision") || inputModalities.includes("image") || attachmentTypes.some((t) => /^image\//i.test(t));
  const supportsImageGen = flag("image") || outputModalities.includes("image") || type === "image";
  const supportsVideo = flag("video") || outputModalities.includes("video") || type === "video";
  const supportsAudio = flag("audio") || inputModalities.includes("audio") || outputModalities.includes("audio");
  let supportsTools = flag("tools", "tool_use", "function_calling", "chat_completion");
  const supportsReasoning =
    flag("reasoning") ||
    item?.reasoning === true ||
    item?.supports_reasoning === true ||
    (Array.isArray(capsObj?.reasoning_effort) && capsObj.reasoning_effort.length > 0);

  // DIAL Core's capabilities object uses chat_completion / completion /
  // embeddings keys (not generic image/video/tools). Honor those too.
  const dc = capsObj ?? {};
  const isEmbedding = type === "embedding" || dc.embeddings === true;
  const isChatModel =
    type === "chat" || type === "completion" || type === "text" || type === "code" || type === ""
      ? true
      : dc.chat_completion === true || dc.completion === true;
  const isChat = isChatModel && !isEmbedding && !supportsImageGen && !supportsVideo;
  // DIAL chat_completion deployments support tool/function calling.
  if (isChatModel && !isEmbedding) supportsTools = true;

  return {
    type: type || (isEmbedding ? "embedding" : "chat"),
    isChat,
    supportsImageInput,
    supportsImageGen,
    supportsVideo,
    supportsAudio,
    supportsTools,
    supportsReasoning,
    inputModalities,
    outputModalities,
  };
}

function modelFromItem(item: any, baseUrl: string) {
  const id = String(item?.id ?? item?.name ?? "");
  const caps = detectCapabilities(item);
  const limits = item?.limits ?? item?.capabilities ?? {};
  const pricing = item?.pricing ?? {};
  const contextWindow = Number(
    item?.context_window ?? item?.contextWindow ?? limits.maxTotalTokens ?? 128_000,
  );
  const maxTokens = Number(
    item?.max_tokens ?? item?.maxTokens ?? limits.maxCompletionTokens ?? Math.min(contextWindow, 16_384),
  );

  return {
    id,
    name: item?.display_name?.plainValue ?? item?.display_name ?? item?.displayName ?? item?.name ?? id,
    api: "openai-completions",
    baseUrl: deploymentUrl(baseUrl, id),
    reasoning: caps.supportsReasoning,
    input: caps.supportsImageInput ? ["text", "image"] : ["text"],
    // Surface each model's real capabilities so Pi (and /list-models) reflects
    // what the deployment can actually do: vision (image input), image/video
    // generation, audio, and tool use. streamDial uses dialCaps to pick the
    // right endpoint at request time.
    capabilities: {
      tools: caps.supportsTools,
      vision: caps.supportsImageInput,
      image: caps.supportsImageGen,
      video: caps.supportsVideo,
      audio: caps.supportsAudio,
      reasoning: caps.supportsReasoning,
    },
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
    // Private metadata consumed by streamDial for endpoint routing. Pi ignores
    // unknown fields on registered models.
    dialType: caps.type,
    dialOutputModalities: caps.outputModalities,
    dialCaps: {
      chat: caps.isChat,
      imageGen: caps.supportsImageGen,
      video: caps.supportsVideo,
      audio: caps.supportsAudio,
      tools: caps.supportsTools,
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

// Merge an optional external abort signal with a hard per-call timeout so a slow
// DIAL endpoint can never hang model discovery (and thus Pi startup).
function withTimeout(signal, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const clear = () => clearTimeout(timer);
  ac.signal.addEventListener("abort", clear, { once: true });
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  return ac.signal;
}

// ---------------------------------------------------------------------------
// Capability-aware streaming
// ---------------------------------------------------------------------------
// DIAL Core (https://github.com/epam/ai-dial-core) exposes chat/completion/
// embedding deployments plus the OpenAI Responses API and Anthropic Messages.
// It does NOT expose any image/video *generation* endpoint, so this extension
// only streams chat deployments and classifies capabilities from the catalog's
// `capabilities` / `input_attachment_types` fields.

function baseOutput(model: any, stopReason: string) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

// DIAL Core has no image/video generation endpoint, so no generation routing
// is implemented here; the image/video generation capability flags stay false.

async function discoverModels(baseUrl: string, apiKey: string, signal?: AbortSignal) {
  const response = await fetch(`${baseUrl}/openai/models`, {
    headers: { "Api-Key": apiKey },
    redirect: "follow",
    signal: withTimeout(signal, 8000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const payload: any = await response.json();
  const items = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return items
    .map((item) => modelFromItem(item, baseUrl))
    .filter((model) => model.id);
}

export default function (pi) {
  const baseUrl = cleanBaseUrl(process.env.DIAL_BASE_URL || DEFAULT_BASE_URL);

  // Route each request to the right endpoint based on the model's detected
  // capabilities: image/video deployments hit DIAL's generation endpoints,
  // everything else uses the OpenAI chat completions stream.
  function streamDial(model: any, context: any, options?: any) {
    const caps = model?.dialCaps ?? {};
    if (caps.chat) return openAICompletionsApi().streamSimple(model, context, options);
    // Non-chat deployment (embedding/...): DIAL Core's API only streams chat /
    // completion / embedding models, so say so clearly rather than 404.
    const stream = createAssistantMessageEventStream();
    const output = baseOutput(model, "pending");
    (async () => {
      try {
        stream.push({ type: "start", partial: output });
        throw new Error(
          `DIAL deployment "${model?.id}" is type "${model?.dialType ?? "unknown"}", which this extension does not stream (use a chat/completion deployment).`,
        );
      } catch (error) {
        output.stopReason = "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: "error", error: output });
        stream.end();
      }
    })();
    return stream;
  }

  // Register immediately with the seed/fallback list (DIAL_MODELS/DIAL_MODEL or
  // empty) so Pi is usable the instant the extension loads. Live model discovery
  // runs in the background via refreshModels and never blocks startup.
  pi.registerProvider(PROVIDER_ID, {
    name: "DIAL",
    // The actual endpoint is model-specific; this value is used only as a fallback.
    baseUrl: `${baseUrl}/openai/deployments`,
    api: "openai-completions",
    apiKey: "$DIAL_API_KEY",
    headers: { "Api-Key": "$DIAL_API_KEY" },
    models: fallbackModels(baseUrl),
    // Capability-aware streaming: image/video deployments are routed to DIAL's
    // generation endpoints; chat deployments use OpenAI completions.
    streamSimple: streamDial,

    async refreshModels({ signal, stored, publish, allowNetwork, credential }) {
      const cached = Array.isArray(stored?.models) ? stored.models : undefined;
      const seed = fallbackModels(baseUrl);
      // Pi's cache-only startup phase, or a cancelled refresh: return what we
      // already have without touching the network.
      if (allowNetwork === false || signal?.aborted) return cached?.length ? cached : seed;

      const apiKey = credential?.key ?? process.env.DIAL_API_KEY ?? "";
      if (!apiKey) return cached?.length ? cached : seed;

      // Single GET /openai/models call returns all deployments (100+ in one
      // response) — fast, and the result is cached for instant startup next time.
      console.error(`[dial] Discovering model catalog from ${baseUrl}/openai/models ...`);
      try {
        const discovered = await discoverModels(baseUrl, apiKey, signal);
        if (discovered.length > 0) {
          await publish({ persist: { provider: PROVIDER_ID, models: discovered } });
          return discovered;
        }
      } catch (error) {
        console.error(`[dial] Model discovery failed (${error instanceof Error ? error.message : String(error)}). Keeping previous list.`);
      }
      return cached?.length ? cached : seed;
    },
  });

  const seed = fallbackModels(baseUrl);
  if (!process.env.DIAL_API_KEY) {
    console.error("[dial] DIAL_API_KEY is not set — discovery skipped. Set it, or set DIAL_MODELS/DIAL_MODEL, before selecting a dial/* model.");
  } else if (seed.length === 0) {
    // Key is present but no seed and no cached catalog yet: the background
    // discovery (single fast /openai/models call) will fill the catalog and
    // cache it. Surface this so an immediate model pick doesn't just error.
    console.error("[dial] No DIAL_MODELS/DIAL_MODEL set and no cached catalog yet — discovering the full list from /openai/models in the background (cached afterwards for instant startup). Need a model right now? Set DIAL_MODELS or run /reload in a moment.");
  }

  registerPricesCommand(pi);
  registerCapabilitiesCommand(pi);
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

function registerCapabilitiesCommand(pi) {
  const flags = {
    reasoning: "reasoning",
    vision: "vision",
    image: "image",
    video: "video",
    audio: "audio",
    tools: "tools",
  };

  pi.registerCommand("dial-capabilities", {
    description:
      "List DIAL deployment capabilities (vision/image/video/audio/tools/reasoning); e.g. /dial-capabilities image",
    handler: async (args, ctx) => {
      const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
      const filter = tokens.find((token) => token in flags);
      const models = ctx.modelRegistry.getAvailable().filter((model) => model.provider === PROVIDER_ID);

      const rows = models
        .map((model) => {
          const caps = model.capabilities ?? {};
          const dialCaps = model.dialCaps ?? {};
          return {
            id: model.id,
            type: model.dialType ?? (dialCaps.chat ? "chat" : "?"),
            reasoning: caps.reasoning ? "✓" : "",
            vision: caps.vision ? "✓" : "",
            image: caps.image ? "✓" : "",
            video: caps.video ? "✓" : "",
            audio: caps.audio ? "✓" : "",
            tools: caps.tools ? "✓" : "",
          };
        })
        .filter((row) => !filter || row[flags[filter]] === "✓")
        .sort((a, b) => (a.type === b.type ? a.id.localeCompare(b.id) : a.type.localeCompare(b.type)));

      const markdown = [
        `# DIAL deployment capabilities${filter ? ` (filter: ${filter})` : ""}`,
        "",
        "| Model | Type | Reasoning | Vision | Image | Video | Audio | Tools |",
        "|---|---|:---:|:---:|:---:|:---:|:---:|:---:|",
        ...rows.map(
          (row) =>
            `| ${row.id} | ${row.type} | ${row.reasoning || "—"} | ${row.vision || "—"} | ${row.image || "—"} | ${row.video || "—"} | ${row.audio || "—"} | ${row.tools || "—"} |`,
        ),
        "",
        "_Capabilities are read from each deployment's DIAL model metadata (type / features / capabilities / modalities)._",
      ].join("\n");

      if (ctx.mode === "tui") {
        pi.appendEntry("dial-capabilities", { markdown });
      } else if (ctx.hasUI) {
        ctx.ui.notify(markdown, "info");
      } else {
        console.log(markdown);
      }
    },
  });

  pi.registerEntryRenderer("dial-capabilities", (entry) => {
    const mdTheme = getMarkdownTheme();
    return new Markdown(entry.data.markdown, 1, 0, mdTheme);
  });
}
