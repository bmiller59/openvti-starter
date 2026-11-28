// The model-facing tool layer (HCP 10.5).
//
// A model calls a tool such as "get the user's food preferences" with a
// question. The tool picks the grant, presents the token, runs the query and
// returns only what the person disclosed: the entries' text, their categories,
// the purpose and each copy's `useUntil`. The token, the grant's refs and the
// provider's directives never appear in a tool's definition or result:
//
//   - the token is held by the client, which builds the document; the tool
//     layer never reads it (HCP 3.11 invariant 14, hcp/entries/query
//     "The access token");
//   - directives are applied here, in code, through `applyDirectives`, never by
//     placing them in the model's context (HCP 6.4, 10.5);
//   - as a last guard, every result is checked against every token the client
//     holds, and one that contains a token is replaced by an error.

import type { HcpAgentClient, QueryOutcome } from "./client.js";
import type { GrantView } from "./wallet.js";

/** One context tool: a fixed set of HCP categories read for one purpose. */
export interface ContextToolSpec {
  /** The tool's name as the model sees it, e.g. `get_food_preferences`. */
  name: string;
  /** What the tool returns, for the model. */
  description: string;
  /** The HCP categories the tool reads; every one must be in the grant. */
  categories: string[];
  /** The purpose code the query names; it must be one of the grant's. */
  purpose: string;
  /** At most this many entries (the provider's ceiling still applies). */
  maxEntries?: number;
}

/** A tool definition in the shape MCP and most model APIs take. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: { question: { type: "string"; description: string } };
    required: ["question"];
    additionalProperties: false;
  };
}

/** One entry as a model sees it. */
export interface ToolEntry {
  text: string;
  categories: string[];
  useUntil: string;
}

/** What a tool call returns to the model. */
export interface ToolResult {
  isError: boolean;
  /** The result as text for the model. */
  text: string;
  /** The same entries, structured, in the provider's order. */
  entries: ToolEntry[];
  purpose?: string;
}

/** The host's decision on a query result, made in code from the grant's directives. */
export type DirectiveDecision = { allow: true } | { allow: false; reason: string };

export interface ContextToolsOptions {
  tools: ContextToolSpec[];
  /**
   * Applies the directives a query returned, in code. Defaults to allowing.
   * The directives themselves are never given to the model.
   */
  applyDirectives?(directives: readonly unknown[], tool: ContextToolSpec): DirectiveDecision;
}

/** Text a model sees when the grant has ended or none covers the tool. */
export const NO_ACCESS = "No access to this part of the person's context. The person has not granted it, or the grant has ended.";
const WITHHELD = "The result was withheld.";

export class ContextTools {
  private readonly specs: Map<string, ContextToolSpec>;

  constructor(
    private readonly client: HcpAgentClient,
    private readonly options: ContextToolsOptions,
  ) {
    this.specs = new Map(options.tools.map((t) => [t.name, t]));
    if (this.specs.size !== options.tools.length) throw new Error("tool names must be unique");
  }

  /** The tool definitions to give the model. They hold no token and no grant identifier. */
  definitions(): ToolDefinition[] {
    return this.options.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {
        type: "object",
        properties: { question: { type: "string", description: "What the agent wants to know, in the person's words where possible." } },
        required: ["question"],
        additionalProperties: false,
      },
    }));
  }

  /** Run tool `name` with the model's input. Never throws for a refusal; throws only for an unknown tool or a bad input. */
  async call(name: string, input: unknown): Promise<ToolResult> {
    const spec = this.specs.get(name);
    if (spec === undefined) throw new Error(`no tool named ${name}`);
    const question = (input as { question?: unknown } | null)?.question;
    if (typeof question !== "string" || question.length === 0) throw new Error(`${name} needs a question`);

    this.client.purgeExpired();
    const grant = this.grantFor(spec);
    if (grant === undefined) return this.guard({ isError: true, text: NO_ACCESS, entries: [] });

    const q: { query: string; purpose: string; categories: string[]; maxEntries?: number } = { query: question, purpose: spec.purpose, categories: spec.categories };
    if (spec.maxEntries !== undefined) q.maxEntries = spec.maxEntries;
    const outcome = await this.client.query(grant.grantId, q);
    return this.guard(this.render(spec, outcome));
  }

  /** An active grant held by the client whose access covers the tool's categories and purpose. */
  private grantFor(spec: ContextToolSpec): GrantView | undefined {
    return this.client.grants().find((g) => {
      if (g.grant.status !== "active") return false;
      return g.grant.access.some((a) => {
        const detail = a as { actions?: string[]; categories?: string[]; purposes?: { code: string }[] };
        return (
          (detail.actions ?? []).includes("read") &&
          spec.categories.every((c) => (detail.categories ?? []).includes(c)) &&
          (detail.purposes ?? []).some((p) => p.code === spec.purpose)
        );
      });
    });
  }

  private render(spec: ContextToolSpec, outcome: QueryOutcome): ToolResult {
    if (outcome.kind !== "entries") return { isError: true, text: NO_ACCESS, entries: [] };
    const decision = this.options.applyDirectives?.(outcome.directives, spec) ?? { allow: true };
    if (!decision.allow) return { isError: true, text: `The person's settings do not allow this: ${decision.reason}`, entries: [], purpose: outcome.purpose };
    const entries: ToolEntry[] = outcome.entries
      .filter((e): e is typeof e & { text: string } => e.text !== undefined)
      .map((e) => ({ text: e.text, categories: e.categories, useUntil: e.useUntil }));
    const lines = entries.map((e) => `- ${e.text} (use until ${e.useUntil})`);
    const text =
      entries.length === 0
        ? `Nothing in the person's context matched. Purpose: ${outcome.purpose}.`
        : `From the person's context, for the purpose ${outcome.purpose}. Do not use any of this after its "use until" time.\n${lines.join("\n")}`;
    return { isError: false, text, entries, purpose: outcome.purpose };
  }

  /** The last guard: a result that contains any token the client holds never reaches the model. */
  private guard(result: ToolResult): ToolResult {
    if (this.client.containsToken(JSON.stringify(result))) return { isError: true, text: WITHHELD, entries: [] };
    return result;
  }
}

/** A tool result as MCP's `CallToolResult`. */
export function toMcpResult(result: ToolResult): { content: { type: "text"; text: string }[]; isError: boolean } {
  return { content: [{ type: "text", text: result.text }], isError: result.isError };
}
