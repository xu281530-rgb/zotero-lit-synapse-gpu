/**
 * Client Configuration Generator for MCP Server
 * Generates JSON configurations for different AI clients
 */

declare let ztoolkit: ZToolkit;
import { getString } from "../utils/locale";
import { serverPreferences } from "./serverPreferences";

export interface ClientConfig {
  name: string;
  displayName: string;
  description: string;
  configTemplate: (port: number, serverName?: string) => any;
  renderConfig?: (port: number, serverName?: string) => string;
  configLanguage?: string;
  getInstructions?: (port?: number) => string[];
}

export class ClientConfigGenerator {
  private static readonly CLIENT_CONFIGS: ClientConfig[] = [
    {
      name: "codex",
      displayName: "Codex CLI",
      description: "OpenAI Codex command line interface",
      configTemplate: (port: number, serverName = "zotero-mcp") => ({
        mcp_servers: {
          [serverName]: {
            type: "http",
            url: `http://127.0.0.1:${port}/mcp`,
            headers: {
              "Content-Type": "application/json"
            }
          }
        }
      }),
      renderConfig: (port: number, serverName = "zotero-mcp") => {
        const safeServerName = ClientConfigGenerator.escapeTomlBasicString(serverName);
        return `[mcp_servers."${safeServerName}"]
type = "http"
url = "http://127.0.0.1:${port}/mcp"

[mcp_servers."${safeServerName}".headers]
"Content-Type" = "application/json"`;
      },
      configLanguage: "toml",
      getInstructions: () => getString("codex-cli-instructions").split("\n").filter(s => s.trim())
    },
    {
      name: "claude-code",
      displayName: "Claude Code",
      description: "Anthropic's Claude Code CLI tool",
      configTemplate: (port: number) => ({
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`
      }),
      renderConfig: (port: number) => {
        return `claude mcp add --transport http zotero-mcp http://127.0.0.1:${port}/mcp`;
      },
      configLanguage: "bash",
      getInstructions: (port: number = 23120) => [
        "══════════════════════════════════════════════════════════",
        "  Claude Code MCP 配置指南",
        "══════════════════════════════════════════════════════════",
        "",
        "▶ 添加服务器（复制上方命令执行即可）",
        "──────────────────────────────────────────────────────────",
        `   claude mcp add --transport http zotero-mcp http://127.0.0.1:${port}/mcp`,
        "",
        "   如需全局可用（所有项目）:",
        `   claude mcp add --transport http --scope user zotero-mcp http://127.0.0.1:${port}/mcp`,
        "",
        "▶ 管理命令",
        "──────────────────────────────────────────────────────────",
        "   查看已添加:   claude mcp list",
        "   查看详情:     claude mcp get zotero-mcp",
        "   移除服务器:   claude mcp remove zotero-mcp",
        "   检查状态:     /mcp (在 Claude Code 中)",
        "",
        "▶ 作用域说明",
        "──────────────────────────────────────────────────────────",
        "   --scope local    仅当前项目（默认）",
        "   --scope project  通过 .mcp.json 共享给团队",
        "   --scope user     所有项目全局可用",
        "",
        "▶ 前提条件",
        "──────────────────────────────────────────────────────────",
        "   ✓ Zotero 必须正在运行",
        "   ✓ MCP 插件服务已启用",
        "   ✓ 添加后无需重启 Claude Code",
        "",
        "══════════════════════════════════════════════════════════"
      ]
    },
    {
      name: "claude-desktop",
      displayName: "Claude Desktop",
      description: "Anthropic's Claude Desktop application",
      configTemplate: (port: number, serverName = "zotero-mcp") => ({
        mcpServers: {
          [serverName]: {
            command: "npx",
            args: ["mcp-remote", `http://127.0.0.1:${port}/mcp`],
            env: {}
          }
        }
      }),
      getInstructions: () => getString("claude-desktop-instructions").split("\n").filter(s => s.trim())
    },
    {
      name: "cline-vscode",
      displayName: "Cline (VS Code)",
      description: "Cline extension for Visual Studio Code",
      configTemplate: (port: number, serverName = "zotero-mcp") => ({
        mcpServers: {
          [serverName]: {
            command: "npx",
            args: ["mcp-remote", `http://127.0.0.1:${port}/mcp`],
            env: {},
            alwaysAllow: ["*"],
            disabled: false
          }
        }
      }),
      getInstructions: () => getString("cline-vscode-instructions").split("\n").filter(s => s.trim())
    },
    {
      name: "continue-dev",
      displayName: "Continue.dev",
      description: "Continue coding assistant",
      configTemplate: (port: number, serverName = "zotero-mcp") => ({
        experimental: {
          modelContextProtocolServers: [
            {
              name: serverName,
              transport: {
                type: "stdio",
                command: "npx",
                args: ["mcp-remote", `http://127.0.0.1:${port}/mcp`]
              }
            }
          ]
        }
      }),
      getInstructions: () => getString("continue-dev-instructions").split("\n").filter(s => s.trim())
    },
    {
      name: "cursor",
      displayName: "Cursor",
      description: "AI-powered code editor",
      configTemplate: (port: number, serverName = "zotero-mcp") => ({
        mcpServers: {
          [serverName]: {
            command: "npx",
            args: ["mcp-remote", `http://127.0.0.1:${port}/mcp`],
            env: {}
          }
        }
      }),
      getInstructions: () => getString("cursor-instructions").split("\n").filter(s => s.trim())
    },
    {
      name: "cherry-studio",
      displayName: "Cherry Studio",
      description: "AI assistant desktop application",
      configTemplate: (port: number, serverName = "zotero-mcp") => ({
        mcpServers: {
          [serverName]: {
            type: "streamableHttp",
            url: `http://127.0.0.1:${port}/mcp`,
            headers: {
              "Content-Type": "application/json"
            }
          }
        }
      }),
      getInstructions: () => getString("cherry-studio-instructions").split("\n").filter(s => s.trim())
    },
    {
      name: "gemini-cli",
      displayName: "Gemini CLI",
      description: "Google Gemini command line interface",
      configTemplate: (port: number, serverName = "zotero-mcp") => ({
        mcpServers: {
          [serverName]: {
            httpUrl: `http://127.0.0.1:${port}/mcp`,
            headers: {
              "Content-Type": "application/json"
            },
            timeout: 60000,
            trust: true
          }
        }
      }),
      getInstructions: () => getString("gemini-cli-instructions").split("\n").filter(s => s.trim())
    },
    {
      name: "chatbox",
      displayName: "Chatbox",
      description: "Desktop AI chat application",
      configTemplate: (port: number, serverName = "zotero-mcp") => ({
        mcpServers: {
          [serverName]: {
            url: `http://127.0.0.1:${port}/mcp`
          }
        }
      }),
      getInstructions: () => getString("chatbox-instructions").split("\n").filter(s => s.trim())
    },
    {
      name: "workbuddy",
      displayName: "WorkBuddy",
      description: "Desktop AI assistant",
      configTemplate: (port: number, serverName = "zotero-mcp") => ({
        mcpServers: {
          [serverName]: {
            command: "npx",
            args: ["mcp-remote", `http://127.0.0.1:${port}/mcp`],
            env: {}
          }
        }
      }),
      getInstructions: () => getString("workbuddy-instructions").split("\n").filter(s => s.trim())
    },
    {
      name: "trae-ai",
      displayName: "Trae AI",
      description: "AI-powered development assistant",
      configTemplate: (port: number, serverName = "zotero-mcp") => ({
        mcpServers: {
          [serverName]: {
            command: "npx",
            args: ["mcp-remote", `http://127.0.0.1:${port}/mcp`],
            env: {}
          }
        }
      }),
      getInstructions: () => getString("trae-ai-instructions").split("\n").filter(s => s.trim())
    },
    {
      name: "qwen-code",
      displayName: "Qwen Code",
      description: "Qwen Code CLI - AI-powered coding assistant",
      configTemplate: (port: number, serverName = "zotero-mcp") => ({
        mcpServers: {
          [serverName]: {
            command: "npx",
            args: ["mcp-remote", `http://127.0.0.1:${port}/mcp`],
            env: {}
          }
        }
      }),
      getInstructions: (port: number = 23120) => [
        "1. Use Qwen Code's MCP add command:",
        `   qwen mcp add zotero-mcp http://127.0.0.1:${port}/mcp -t http`,
        "",
        "2. Alternatively, add with custom headers and options:",
        `   qwen mcp add zotero-mcp http://127.0.0.1:${port}/mcp \\`,
        "     -t http \\",
        "     -H 'Content-Type: application/json' \\",
        "     -H 'User-Agent: Qwen-Code-MCP-Client' \\",
        "     --trust",
        "",
        "3. Verify the server was added:",
        "   qwen mcp list",
        "",
        "4. Available MCP tools in Qwen Code:",
        "   - hybrid_search: STAGE 1; classify the field, adopt that expert role, then run keyword retrieval (library metadata + indexed body text) and semantic retrieval over the whole library. Each branch is filtered against its own relevance threshold and the survivors are unioned - clearing either one is enough - then ranked by weighted Reciprocal Rank Fusion. Pass a complete natural-language query, bilingual Chinese/English keywords (about 5-12 recommended), and the domain/expertRole you reasoned from. Returns lightweight candidate rows - metadata, the RRF ranking score plus each branch's own 0-1 relevance, matched keywords/fields, a short evidence snippet, language - WITHOUT abstracts",
        "   - search_library: Search your Zotero library by exact/field relevance",
        "   - semantic_search: Search by embedding similarity only",
        "   - get_annotations: Get annotations and notes",
        "   - get_attachment_text: Read one attachment's extracted text",
        "   - get_collections: Browse your collections",
        "   - get_item_abstract: STAGE 2; one item's abstract, on demand. Call it only for a candidate you are seriously considering reading in depth - never across the whole result set",
        "   - search_fulltext: STAGE 3; hybrid keyword+semantic search over the passages of ONE document from hybrid_search. Re-derive query and keywords from that specific paper, in that paper's own language, then optionally expand neighbouring passages by chunkId",
        "   - And more research tools!",
        "",
        "5. Funnel flow: hybrid_search over the whole library first (query + bilingual keywords + domain + expertRole) returns lightweight candidate rows without abstracts. Triage from those rows; only for a paper you are seriously considering, call get_item_abstract on that one itemKey. Having read that abstract, redo the expert analysis for THAT paper - re-fit domain and expertRole, write a query and keywords from its own subject matter in its own language (one language, not both) - and call search_fulltext with its single itemKey. Read the returned passages and stop when the evidence is enough; only pull neighbouring passages by chunkId when a passage is missing its context.",
        "",
        "6. Start using the tools with @ syntax:",
        "   Example: /analyze @zotero:hybrid_search query:\"machine learning for alloy design / 面向合金设计的机器学习\" keywords:[\"machine learning\",\"alloy design\",\"机器学习\",\"合金设计\"]",
        "",
        "7. Use /mcp command to verify MCP server is active",
        "",
        "Note: Ensure Zotero is running and the MCP plugin server is enabled",
        "",
        "Configuration file location: ~/.qwen/settings.json or .qwen/settings.json",
        "",
        "Troubleshooting:",
        "- If connection fails, check server status with 'qwen mcp list'",
        "- Use --trust flag to bypass tool call confirmation prompts",
        "- Configuration uses 127.0.0.1 instead of localhost for better compatibility"
      ]
    },
    {
      name: "custom-http",
      displayName: "自定义 HTTP 客户端",
      description: "通用 HTTP MCP 客户端配置",
      configTemplate: (port: number, serverName = "zotero-mcp") => ({
        name: serverName,
        description: "Zotero MCP Server - Research management and citation tools",
        transport: {
          type: "http",
          endpoint: `http://127.0.0.1:${port}/mcp`,
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          }
        },
        capabilities: {
          tools: true,
          resources: false,
          prompts: false
        },
        connectionTest: `curl -X POST http://127.0.0.1:${port}/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}'`
      }),
      getInstructions: () => getString("custom-http-instructions").split("\n").filter(s => s.trim())
    }
  ];

  static getAvailableClients(): ClientConfig[] {
    return this.CLIENT_CONFIGS;
  }

  static generateConfig(clientName: string, port: number, serverName?: string): string {
    const client = this.CLIENT_CONFIGS.find(c => c.name === clientName);
    if (!client) {
      throw new Error(`Unsupported client: ${clientName}`);
    }

    if (client.renderConfig) {
      return client.renderConfig(port, serverName || "zotero-mcp");
    }

    const config = client.configTemplate(port, serverName || "zotero-mcp");
    return JSON.stringify(config, null, 2);
  }

  static getInstructions(clientName: string, port?: number): string[] {
    const client = this.CLIENT_CONFIGS.find(c => c.name === clientName);
    return client?.getInstructions?.(port) || [];
  }

  /**
   * 开启鉴权时补一段令牌说明。
   *
   * 服务端在 allowRemote / requireAuth 打开后会拒绝不带 Bearer 令牌的请求，
   * 而这些客户端模板本身不含 Authorization 头；不把令牌告诉用户，等于开了
   * 鉴权就再也连不上。这里只在需要时追加一段文本，不改任何模板结构。
   */
  private static buildAuthNotice(): string {
    try {
      if (!serverPreferences.isAuthRequired()) return "";
      const token = serverPreferences.getAuthToken();
      if (!token) {
        return [
          "",
          "## Access token required",
          "",
          "Remote access is enabled but no access token has been generated yet.",
          "Open the plugin preferences and regenerate the MCP access token first.",
          "",
        ].join("\n");
      }
      return [
        "",
        "## Access token required",
        "",
        "This server rejects requests without a bearer token. Add this header to the",
        "configuration below (the `headers` block, or `--header` for CLI clients):",
        "",
        "```",
        `Authorization: Bearer ${token}`,
        "```",
        "",
        "Keep the token private; anyone holding it can read and modify your library.",
        "",
      ].join("\n");
    } catch {
      return "";
    }
  }

  static generateFullGuide(clientName: string, port: number, serverName?: string): string {
    const client = this.CLIENT_CONFIGS.find(c => c.name === clientName);
    if (!client) {
      throw new Error(`Unsupported client: ${clientName}`);
    }

    const config = this.generateConfig(clientName, port, serverName);
    const authNotice = this.buildAuthNotice();
    const instructions = this.getInstructions(clientName, port);
    const actualServerName = serverName || "zotero-mcp";
    const codeLanguage = client.configLanguage || "json";

    return `${getString("config-guide-header", { args: { clientName: client.displayName } })}

${getString("config-guide-server-info")}
${getString("config-guide-server-name", { args: { serverName: actualServerName } })}
${getString("config-guide-server-port", { args: { port: port.toString() } })}
${getString("config-guide-server-endpoint", { args: { port: port.toString() } })}
${authNotice}
${getString("config-guide-json-header")}
\`\`\`${codeLanguage}
${config}
\`\`\`

${getString("config-guide-steps-header")}
${instructions.map(instruction => instruction).join('\n')}

${getString("config-guide-tools-header")}
${getString("config-guide-tools-list")}

${getString("config-guide-troubleshooting-header")}
${getString("config-guide-troubleshooting-list")}

${getString("config-guide-generated-time", { args: { time: new Date().toLocaleString() } })}
`;
  }

  private static escapeTomlBasicString(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  static async copyToClipboard(text: string): Promise<boolean> {
    try {
      // Try Zotero's built-in clipboard API first
      if (typeof Zotero !== 'undefined' && Zotero.Utilities && Zotero.Utilities.Internal && Zotero.Utilities.Internal.copyTextToClipboard) {
        Zotero.Utilities.Internal.copyTextToClipboard(text);
        return true;
      }
      
      // Try standard clipboard API
      const globalNav = (globalThis as any).navigator;
      if (globalNav && globalNav.clipboard) {
        await globalNav.clipboard.writeText(text);
        return true;
      }
      
      // Try with global document
      if (typeof ztoolkit !== 'undefined' && ztoolkit.getGlobal) {
        const globalWindow = ztoolkit.getGlobal('window');
        if (globalWindow && globalWindow.document) {
          const textArea = globalWindow.document.createElement('textarea');
          textArea.value = text;
          textArea.style.position = 'fixed';
          textArea.style.left = '-999999px';
          textArea.style.top = '-999999px';
          globalWindow.document.body.appendChild(textArea);
          textArea.focus();
          textArea.select();
          const result = globalWindow.document.execCommand('copy');
          globalWindow.document.body.removeChild(textArea);
          return result;
        }
      }
      
      return false;
    } catch (error) {
      ztoolkit.log(`[ClientConfigGenerator] Failed to copy to clipboard: ${error}`, "error");
      return false;
    }
  }
}
