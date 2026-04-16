import { BaseTool, ToolResult } from "./base.js";

/**
 * Web search via Tavily API.
 * Returns extracted text content from search results.
 */
export class WebSearchTool extends BaseTool {
  /**
   * @param {string} apiKey - Tavily API key
   */
  constructor(apiKey) {
    super();
    this._apiKey = apiKey;
  }

  get name() { return "web_search"; }

  get description() {
    return (
      "Search the web for information using Tavily. Returns extracted text from top results. " +
      "IMPORTANT: Always prioritize information from user-provided domain documents " +
      "(uploaded regulations, sample files, workspace documents) over web search results. " +
      "Use web search only when: (1) the needed information is not in provided documents, " +
      "(2) you need to verify or supplement document content with external sources, or " +
      "(3) the user explicitly asks for web information (e.g., latest LLM model info, API docs)."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        search_depth: {
          type: "string",
          enum: ["basic", "advanced"],
          description: "Search depth: 'basic' for fast results, 'advanced' for more thorough search (default: basic)",
        },
        max_results: {
          type: "integer",
          description: "Maximum number of results to return (default: 5, max: 10)",
        },
      },
      required: ["query"],
    };
  }

  async execute(input) {
    const query = input.query || "";
    if (!query.trim()) {
      return new ToolResult("No query provided", true);
    }

    if (!this._apiKey) {
      return new ToolResult(
        "Web search is not configured. Set TAVILY_API_KEY in your .env file or global config.",
        true,
      );
    }

    const searchDepth = input.search_depth || "basic";
    const maxResults = Math.min(input.max_results || 5, 10);

    try {
      const resp = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this._apiKey,
          query,
          search_depth: searchDepth,
          max_results: maxResults,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        const text = await resp.text();
        return new ToolResult(`Tavily API error ${resp.status}: ${text}`, true);
      }

      const data = await resp.json();
      const results = data.results || [];

      if (results.length === 0) {
        return new ToolResult(`No results found for: ${query}`);
      }

      const lines = [];
      for (const r of results) {
        lines.push(`--- ${r.title || "Untitled"} ---`);
        lines.push(`URL: ${r.url || ""}`);
        lines.push(r.content || "(no content)");
        lines.push("");
      }

      return new ToolResult(
        `Found ${results.length} result(s) for "${query}":\n\n${lines.join("\n")}`,
      );
    } catch (err) {
      return new ToolResult(`Web search failed: ${err.message}`, true);
    }
  }
}
