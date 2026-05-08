import chalk from "chalk";

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
const PAGE_LIMIT = 1000;

export type Format = "text" | "json";

export interface ModelsOptions {
  verbose: boolean;
  format: Format;
  /** Override `ANTHROPIC_API_KEY` lookup (tests). */
  apiKey?: string;
  /** Override `globalThis.fetch` (tests). */
  fetchImpl?: typeof fetch;
  /** Override stdout (tests). */
  stdout?: NodeJS.WritableStream;
}

export interface CapabilitySupport {
  supported: boolean;
}

export interface ModelCapabilities {
  batch: CapabilitySupport;
  citations: CapabilitySupport;
  code_execution: CapabilitySupport;
  context_management: CapabilitySupport;
  effort: CapabilitySupport;
  image_input: CapabilitySupport;
  pdf_input: CapabilitySupport;
  structured_outputs: CapabilitySupport;
  thinking: CapabilitySupport;
}

export interface ModelInfo {
  id: string;
  display_name: string;
  created_at: string;
  max_input_tokens: number | null;
  max_tokens: number | null;
  type: "model";
  capabilities: ModelCapabilities | null;
}

interface ModelsPage {
  data: ModelInfo[];
  has_more: boolean;
  last_id: string | null;
}

export class ModelsCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsCommandError";
  }
}

export async function runModelsCommand(opts: ModelsOptions): Promise<void> {
  const apiKey = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new ModelsCommandError(
      "missing ANTHROPIC_API_KEY: set it in your environment to call the Anthropic API",
    );
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stdout = opts.stdout ?? process.stdout;

  const models = await fetchAllModels(apiKey, fetchImpl);

  const output =
    opts.format === "json"
      ? formatJson(models)
      : opts.verbose
        ? formatTextVerbose(models)
        : formatTextSimple(models);
  stdout.write(`${output}\n`);
}

async function fetchAllModels(apiKey: string, fetchImpl: typeof fetch): Promise<ModelInfo[]> {
  const all: ModelInfo[] = [];
  let afterId: string | null = null;
  for (;;) {
    const url = new URL(ANTHROPIC_MODELS_URL);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (afterId) url.searchParams.set("after_id", afterId);

    const res = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
    });

    if (!res.ok) throw await buildHttpError(res);

    const page = (await res.json()) as ModelsPage;
    all.push(...page.data);
    if (!page.has_more || !page.last_id) break;
    afterId = page.last_id;
  }
  return all;
}

async function buildHttpError(res: Response): Promise<ModelsCommandError> {
  const body = await res.text().catch(() => "");
  const snippet = body.slice(0, 300);
  if (res.status === 401) {
    return new ModelsCommandError(
      `Anthropic API rejected the request (HTTP 401): your ANTHROPIC_API_KEY is missing, invalid, or revoked. ${snippet}`,
    );
  }
  if (res.status === 429) {
    return new ModelsCommandError(
      `Anthropic API rate-limited the request (HTTP 429). Wait a moment and retry. ${snippet}`,
    );
  }
  return new ModelsCommandError(
    `Anthropic API call failed: HTTP ${res.status} ${res.statusText}. ${snippet}`,
  );
}

function formatJson(models: ModelInfo[]): string {
  return JSON.stringify({ data: models }, null, 2);
}

interface SimpleColumn {
  header: string;
  cell: (m: ModelInfo) => string;
}

const SIMPLE_COLUMNS: SimpleColumn[] = [
  { header: "ID", cell: (m) => m.id },
  { header: "Display Name", cell: (m) => m.display_name },
];

const CAPABILITY_COLUMNS: { header: string; key: keyof ModelCapabilities }[] = [
  { header: "Bat", key: "batch" },
  { header: "Cit", key: "citations" },
  { header: "Code", key: "code_execution" },
  { header: "Img", key: "image_input" },
  { header: "Pdf", key: "pdf_input" },
  { header: "Stru", key: "structured_outputs" },
  { header: "Thnk", key: "thinking" },
  { header: "Ctx", key: "context_management" },
  { header: "Eff", key: "effort" },
];

function formatTextSimple(models: ModelInfo[]): string {
  return renderTable(
    SIMPLE_COLUMNS.map((c) => c.header),
    models.map((m) => SIMPLE_COLUMNS.map((c) => c.cell(m))),
  );
}

function formatTextVerbose(models: ModelInfo[]): string {
  const headers = [
    "ID",
    "Display Name",
    "Created",
    "MaxIn",
    "MaxOut",
    ...CAPABILITY_COLUMNS.map((c) => c.header),
  ];
  const rows = models.map((m) => [
    m.id,
    m.display_name,
    formatDate(m.created_at),
    formatNum(m.max_input_tokens),
    formatNum(m.max_tokens),
    ...CAPABILITY_COLUMNS.map((c) => boolMark(m.capabilities?.[c.key]?.supported ?? null)),
  ]);
  return renderTable(headers, rows);
}

/**
 * Render a left-aligned, space-padded table. Column widths are computed from
 * the visible (ANSI-stripped) length of each cell so coloured glyphs don't
 * skew alignment.
 */
function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(visibleLen(h), ...rows.map((r) => visibleLen(r[i] ?? ""))),
  );
  const sep = "  ";
  const headerLine = headers.map((h, i) => chalk.bold(padRight(h, widths[i] ?? 0))).join(sep);
  const bodyLines = rows.map((r) =>
    r.map((cell, i) => padRight(cell, widths[i] ?? 0)).join(sep),
  );
  return [headerLine, ...bodyLines].join("\n");
}

function padRight(s: string, width: number): string {
  const pad = width - visibleLen(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

function boolMark(value: boolean | null): string {
  if (value === null) return "–";
  return value ? chalk.green("✓") : chalk.red("✗");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatNum(n: number | null): string {
  return n === null ? "–" : n.toLocaleString("en-US");
}
