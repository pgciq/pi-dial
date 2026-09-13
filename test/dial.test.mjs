import assert from "node:assert/strict";
import test from "node:test";
import registerDial from "../extensions/dial.ts";

const DIAL_ENV_NAMES = ["DIAL_API_KEY", "DIAL_BASE_URL", "DIAL_MODEL", "DIAL_MODELS"];

async function withDialEnv(values, run) {
  const previous = Object.fromEntries(DIAL_ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of DIAL_ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);

  try {
    return await run();
  } finally {
    for (const name of DIAL_ENV_NAMES) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

function captureProvider() {
  let registered;
  const noop = () => {};
  registerDial({
    registerProvider: (id, config) => {
      registered = { id, config };
    },
    registerCommand: noop,
    registerEntryRenderer: noop,
    on: noop,
  });
  assert.ok(registered, "extension did not register a provider");
  return registered;
}

test("registers configured fallback deployments immediately", async () => {
  await withDialEnv(
    {
      DIAL_API_KEY: "test-key",
      DIAL_BASE_URL: "https://dial.example/",
      DIAL_MODELS: "first-model, gemini-3.8-flash",
    },
    () => {
      const { id, config } = captureProvider();

      assert.equal(id, "dial");
      assert.deepEqual(
        config.models.map((model) => model.id),
        ["first-model", "gemini-3.8-flash"],
      );
      assert.equal(
        config.models[1].baseUrl,
        "https://dial.example/openai/deployments/gemini-3.8-flash",
      );
    },
  );
});

test("maps canonical DIAL catalog metadata without inventing tool support", async () => {
  await withDialEnv(
    { DIAL_API_KEY: "test-key", DIAL_BASE_URL: "https://dial.example" },
    async () => {
      const originalFetch = globalThis.fetch;
      let requestedUrl;
      let requestedHeaders;
      globalThis.fetch = async (url, init) => {
        requestedUrl = String(url);
        requestedHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "chat-model",
                type: "chat",
                display_name: { plainValue: "Chat model" },
                features: { tools: false },
                capabilities: { chat_completion: true },
                input_attachment_types: ["image/*"],
                limits: { max_total_tokens: 80_000, max_completion_tokens: 8_000 },
                pricing: { prompt: "0.000002", completion: "0.00001" },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      try {
        const { config } = captureProvider();
        let persisted;
        const models = await config.refreshModels({
          signal: new AbortController().signal,
          stored: undefined,
          publish: async (entry) => {
            persisted = entry.persist;
          },
          allowNetwork: true,
          credential: { key: "test-key" },
        });

        assert.equal(requestedUrl, "https://dial.example/openai/models");
        assert.equal(requestedHeaders.get("Api-Key"), "test-key");
        assert.equal(models[0].name, "Chat model");
        assert.equal(models[0].contextWindow, 80_000);
        assert.equal(models[0].maxTokens, 8_000);
        assert.equal(models[0].capabilities.tools, false);
        assert.deepEqual(models[0].input, ["text", "image"]);
        assert.equal(models[0].cost.input, 2);
        assert.equal(models[0].cost.output, 10);
        assert.deepEqual(persisted.models, models);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

test("disambiguates equal display names and removes duplicate deployment ids", async () => {
  await withDialEnv(
    { DIAL_API_KEY: "test-key", DIAL_BASE_URL: "https://dial.example" },
    async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "gpt-a", display_name: "GPT-4", pricing: { prompt: "0.000001" } },
              { id: "gpt-a", display_name: "GPT-4", pricing: { prompt: "0.000009" } },
              { id: "gpt-b", display_name: "GPT-4", pricing: { prompt: "0.000002" } },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );

      try {
        const { config } = captureProvider();
        const models = await config.refreshModels({
          signal: new AbortController().signal,
          stored: undefined,
          publish: async () => {},
          allowNetwork: true,
          credential: { key: "test-key" },
        });

        assert.deepEqual(models.map((model) => model.id), ["gpt-a", "gpt-b"]);
        assert.deepEqual(models.map((model) => model.name), ["GPT-4 (gpt-a)", "GPT-4 (gpt-b)"]);
        assert.equal(models[0].cost.input, 1);
        assert.equal(models[1].cost.input, 2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

test("sends the DIAL key without an OpenAI bearer header", async () => {
  await withDialEnv(
    {
      DIAL_API_KEY: "test-key",
      DIAL_BASE_URL: "https://dial.example",
      DIAL_MODEL: "chat-model",
    },
    async () => {
      const { config } = captureProvider();
      const model = { ...config.models[0], provider: "dial" };
      let requestedUrl;
      let requestedHeaders;

      const fetch = async (url, init) => {
        requestedUrl = String(url);
        requestedHeaders = new Headers(init?.headers);
        const body = [
          'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"chat-model","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
          'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"chat-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
          "data: [DONE]",
          "",
        ].join("\n\n");
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      };

      const stream = config.streamSimple(
        model,
        {
          systemPrompt: "",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
              timestamp: Date.now(),
            },
          ],
          tools: [],
        },
        { apiKey: "test-key", headers: { "Api-Key": "test-key" }, fetch },
      );
      await stream.result();

      assert.equal(
        requestedUrl,
        "https://dial.example/openai/deployments/chat-model/chat/completions",
      );
      assert.equal(requestedHeaders.get("Api-Key"), "test-key");
      assert.equal(requestedHeaders.has("Authorization"), false);
    },
  );
});
