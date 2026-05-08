import { describe, expect, it } from "vitest";
import {
  ModelsCommandError,
  runModelsCommand,
  type ModelInfo,
} from "../commands/models.js";

describe("runModelsCommand", () => {
  it("calls the Anthropic models endpoint with key + version headers", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = makeFetch(calls, [singlePage([haiku()])]);
    const stdout = makeStdout();

    await runModelsCommand({
      verbose: false,
      format: "text",
      apiKey: "test-key",
      fetchImpl,
      stdout,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models\?/);
    expect(call.url).toContain("limit=1000");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("simple text output lists every model with id and display name and no capability columns", async () => {
    const fetchImpl = makeFetch([], [singlePage([haiku(), opus()])]);
    const stdout = makeStdout();

    await runModelsCommand({
      verbose: false,
      format: "text",
      apiKey: "k",
      fetchImpl,
      stdout,
    });

    const out = stripAnsi(stdout.text());
    expect(out).toContain("ID");
    expect(out).toContain("Display Name");
    expect(out).toContain("claude-haiku-4-5-20251001");
    expect(out).toContain("Claude Haiku 4.5");
    expect(out).toContain("claude-opus-4-7");
    expect(out).toContain("Claude Opus 4.7");
    expect(out).not.toContain("Bat");
    expect(out).not.toContain("MaxIn");
  });

  it("verbose text output renders capability headers and ✓ / ✗ / – marks", async () => {
    const mixed: ModelInfo = {
      id: "claude-mix-1",
      display_name: "Mix",
      created_at: "2025-09-01T00:00:00Z",
      max_input_tokens: 200_000,
      max_tokens: 64_000,
      type: "model",
      capabilities: {
        batch: { supported: true },
        citations: { supported: false },
        code_execution: { supported: true },
        context_management: { supported: false },
        effort: { supported: true },
        image_input: { supported: true },
        pdf_input: { supported: false },
        structured_outputs: { supported: true },
        thinking: { supported: false },
      },
    };
    const noCaps: ModelInfo = {
      id: "claude-legacy-1",
      display_name: "Legacy",
      created_at: "2024-01-01T00:00:00Z",
      max_input_tokens: null,
      max_tokens: null,
      type: "model",
      capabilities: null,
    };
    const fetchImpl = makeFetch([], [singlePage([mixed, noCaps])]);
    const stdout = makeStdout();

    await runModelsCommand({
      verbose: true,
      format: "text",
      apiKey: "k",
      fetchImpl,
      stdout,
    });

    const out = stripAnsi(stdout.text());
    expect(out).toContain("MaxIn");
    expect(out).toContain("Bat");
    expect(out).toContain("Stru");
    expect(out).toContain("✓");
    expect(out).toContain("✗");
    expect(out).toContain("–");
    expect(out).toContain("200,000");
    expect(out).toContain("2025-09-01");
    expect(out).toContain("Key:");
    expect(out).toContain("Bat");
    expect(out).toContain("Batch API");
    expect(out).toContain("Stru");
    expect(out).toContain("Structured outputs");
    expect(out).toContain("MaxIn");
    expect(out).toContain("Max input tokens");
    expect(out).toMatch(/✓ supported/);
  });

  it("json output is parseable and round-trips every model", async () => {
    const models = [haiku(), opus()];
    const fetchImpl = makeFetch([], [singlePage(models)]);
    const stdout = makeStdout();

    await runModelsCommand({
      verbose: false,
      format: "json",
      apiKey: "k",
      fetchImpl,
      stdout,
    });

    const parsed = JSON.parse(stdout.text()) as { data: ModelInfo[] };
    expect(parsed.data).toHaveLength(models.length);
    expect(parsed.data.map((m) => m.id)).toEqual(models.map((m) => m.id));
  });

  it("paginates with after_id when has_more is true", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = makeFetch(calls, [
      {
        data: [haiku()],
        has_more: true,
        last_id: "claude-haiku-4-5-20251001",
      },
      singlePage([opus()]),
    ]);
    const stdout = makeStdout();

    await runModelsCommand({
      verbose: false,
      format: "json",
      apiKey: "k",
      fetchImpl,
      stdout,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).not.toContain("after_id");
    expect(calls[1]!.url).toContain("after_id=claude-haiku-4-5-20251001");

    const parsed = JSON.parse(stdout.text()) as { data: ModelInfo[] };
    expect(parsed.data.map((m) => m.id)).toEqual(["claude-haiku-4-5-20251001", "claude-opus-4-7"]);
  });

  it("throws when ANTHROPIC_API_KEY is missing", async () => {
    const fetchImpl = makeFetch([], [singlePage([haiku()])]);
    const stdout = makeStdout();

    await expect(
      runModelsCommand({
        verbose: false,
        format: "text",
        apiKey: "",
        fetchImpl,
        stdout,
      }),
    ).rejects.toBeInstanceOf(ModelsCommandError);
  });

  it("translates HTTP 401 into a friendly ModelsCommandError", async () => {
    const fetchImpl = (() => {
      return async () =>
        new Response("forbidden", { status: 401, statusText: "Unauthorized" });
    })() as unknown as typeof fetch;
    const stdout = makeStdout();

    const err = await runModelsCommand({
      verbose: false,
      format: "text",
      apiKey: "bogus",
      fetchImpl,
      stdout,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelsCommandError);
    expect((err as Error).message).toMatch(/401/);
    expect((err as Error).message).toMatch(/ANTHROPIC_API_KEY/);
  });
});

function haiku(): ModelInfo {
  return {
    id: "claude-haiku-4-5-20251001",
    display_name: "Claude Haiku 4.5",
    created_at: "2025-10-01T00:00:00Z",
    max_input_tokens: 200_000,
    max_tokens: 64_000,
    type: "model",
    capabilities: {
      batch: { supported: true },
      citations: { supported: true },
      code_execution: { supported: true },
      context_management: { supported: true },
      effort: { supported: true },
      image_input: { supported: true },
      pdf_input: { supported: true },
      structured_outputs: { supported: true },
      thinking: { supported: true },
    },
  };
}

function opus(): ModelInfo {
  return {
    id: "claude-opus-4-7",
    display_name: "Claude Opus 4.7",
    created_at: "2026-01-15T00:00:00Z",
    max_input_tokens: 1_000_000,
    max_tokens: 64_000,
    type: "model",
    capabilities: {
      batch: { supported: true },
      citations: { supported: true },
      code_execution: { supported: true },
      context_management: { supported: true },
      effort: { supported: true },
      image_input: { supported: true },
      pdf_input: { supported: true },
      structured_outputs: { supported: true },
      thinking: { supported: true },
    },
  };
}

interface PageBody {
  data: ModelInfo[];
  has_more: boolean;
  last_id: string | null;
}

function singlePage(data: ModelInfo[]): PageBody {
  return { data, has_more: false, last_id: data.at(-1)?.id ?? null };
}

function makeFetch(
  calls: { url: string; init: RequestInit }[],
  pages: PageBody[],
): typeof fetch {
  let i = 0;
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    const body = pages[i] ?? pages.at(-1);
    if (!body) throw new Error("makeFetch: no pages configured");
    i += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return impl as unknown as typeof fetch;
}

interface FakeStdout extends NodeJS.WritableStream {
  text(): string;
}

function makeStdout(): FakeStdout {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    },
    text(): string {
      return chunks.join("");
    },
  };
  return stream as unknown as FakeStdout;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
