startup-begin = Addon is loading
startup-finish = Addon is ready
menuitem-label = Zotero LitSynapse: Helper Examples
menupopup-label = Zotero LitSynapse: Menupopup
menuitem-submenulabel = Zotero LitSynapse
menuitem-filemenulabel = Zotero LitSynapse: File Menuitem
prefs-title = LitSynapse
prefs-table-title = Title
prefs-table-detail = Detail
tabpanel-lib-tab-label = Lib Tab
tabpanel-reader-tab-label = Reader Tab
# Client Configuration Instructions
codex-cli-instructions =
    ══════════════════════════════════════════════════════════
      Codex CLI MCP Configuration Guide
    ══════════════════════════════════════════════════════════

    ▶ Method 1: CLI Command (Recommended)
    ──────────────────────────────────────────────────────────
       codex mcp add zotero-lit-synapse http://127.0.0.1:23120/mcp -t http

    ▶ Method 2: TOML Configuration File
    ──────────────────────────────────────────────────────────
       1. Open ~/.codex/config.toml
       2. Add the generated TOML snippet under [mcp_servers]
       3. Keep the headers block:
claude-desktop-instructions =
    ══════════════════════════════════════════════════════════
      Claude Desktop MCP Configuration Guide
    ══════════════════════════════════════════════════════════

    ▶ Configuration File Location
    ──────────────────────────────────────────────────────────
       Windows: %APPDATA%\Claude\claude_desktop_config.json
       macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
       Linux: ~/.config/claude/claude_desktop_config.json

    ▶ Configuration Steps
    ──────────────────────────────────────────────────────────
       1. Copy the generated JSON config to config file
       2. Restart Claude Desktop application
       3. Or add in Settings > Developer > MCP Servers

    ▶ Prerequisites
    ──────────────────────────────────────────────────────────
       ✓ Node.js required (for npx mcp-remote)
       ✓ Zotero must be running
       ✓ MCP server must be enabled

    ▶ Troubleshooting
    ──────────────────────────────────────────────────────────
       • Connection failed: Check if Zotero is running
       • npx error: Ensure Node.js is installed
       • Config not applied: Restart Claude Desktop

    ══════════════════════════════════════════════════════════
cline-vscode-instructions =
    ══════════════════════════════════════════════════════════
      Cline (VS Code) MCP Configuration Guide
    ══════════════════════════════════════════════════════════

    ▶ Method 1: Via UI
    ──────────────────────────────────────────────────────────
       1. Click 'Configure MCP Servers' at bottom of Cline panel
       2. Or click 'MCP Servers' icon in top navigation
       3. Select 'Installed' tab
       4. Click 'Advanced MCP Settings' link
       5. Paste config into JSON file

    ▶ Method 2: Direct Config Edit
    ──────────────────────────────────────────────────────────
       Config location: ~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json

    ▶ Prerequisites
    ──────────────────────────────────────────────────────────
       ✓ Node.js required
       ✓ Zotero must be running
       ✓ alwaysAllow: ["*"] auto-approves tool calls

    ══════════════════════════════════════════════════════════
continue-dev-instructions =
    ══════════════════════════════════════════════════════════
      Continue.dev MCP Configuration Guide
    ══════════════════════════════════════════════════════════

    ▶ Configuration File Location
    ──────────────────────────────────────────────────────────
       JSON: ~/.continue/config.json
       YAML: ~/.continue/config.yaml

    ▶ Configuration Steps
    ──────────────────────────────────────────────────────────
       1. Merge config into experimental.modelContextProtocolServers
       2. Save configuration file
       3. Reload Continue extension

    ▶ Prerequisites
    ──────────────────────────────────────────────────────────
       ✓ Node.js required
       ✓ Zotero must be running

    ══════════════════════════════════════════════════════════
cursor-instructions =
    ══════════════════════════════════════════════════════════
      Cursor MCP Configuration Guide
    ══════════════════════════════════════════════════════════

    ▶ Configuration File Location
    ──────────────────────────────────────────────────────────
       Global config: ~/.cursor/mcp.json
       Project config: .cursor/mcp.json (in project root)

    ▶ Configuration Steps
    ──────────────────────────────────────────────────────────
       1. Add generated JSON config to mcp.json
       2. Save file
       3. Restart Cursor editor

    ▶ Prerequisites
    ──────────────────────────────────────────────────────────
       ✓ Node.js required
       ✓ Zotero must be running

    ▶ Troubleshooting
    ──────────────────────────────────────────────────────────
       • Tools not showing: Try restarting Cursor
       • Connection timeout: Check if Zotero is running

    ══════════════════════════════════════════════════════════
cherry-studio-instructions =
    ══════════════════════════════════════════════════════════
      Cherry Studio MCP Configuration Guide
    ══════════════════════════════════════════════════════════

    ▶ Configuration Steps
    ──────────────────────────────────────────────────────────
       1. Open Cherry Studio application
       2. Go to Settings > MCP Servers
       3. Click 'Add Server' button
       4. Select 'Import from JSON'
       5. Paste generated configuration
       6. Save and return to chat page

    ▶ Notes
    ──────────────────────────────────────────────────────────
       ✓ Uses streamableHttp transport type
       ✓ Ensure MCP is enabled in chat page
       ✓ Zotero must be running

    ══════════════════════════════════════════════════════════
gemini-cli-instructions =
    ══════════════════════════════════════════════════════════
      Gemini CLI MCP Configuration Guide
    ══════════════════════════════════════════════════════════

    ▶ Configuration File Location
    ──────────────────────────────────────────────────────────
       Global config: ~/.gemini/settings.json
       Project config: .gemini/settings.json

    ▶ Configuration Steps
    ──────────────────────────────────────────────────────────
       1. Add generated config to settings.json
       2. Use /mcp command to verify server

    ▶ Configuration Options
    ──────────────────────────────────────────────────────────
       • httpUrl: HTTP endpoint address
       • timeout: Request timeout in milliseconds
       • trust: true to skip tool confirmation prompts

    ▶ Prerequisites
    ──────────────────────────────────────────────────────────
       ✓ Zotero must be running
       ✓ No additional dependencies required

    ══════════════════════════════════════════════════════════
workbuddy-instructions =
    ══════════════════════════════════════════════════════════
      WorkBuddy MCP Configuration Guide
    ══════════════════════════════════════════════════════════

    ▶ Configuration Steps
    ──────────────────────────────────────────────────────────
       1. Open WorkBuddy and locate the MCP server settings (mcp.json)
       2. Add the generated config to the mcpServers section
       3. Save and restart WorkBuddy

    ▶ Prerequisites
    ──────────────────────────────────────────────────────────
       • Node.js must be installed (the config uses npx mcp-remote)
       • Zotero must be running with the MCP server enabled
chatbox-instructions =
    ══════════════════════════════════════════════════════════
      Chatbox MCP Configuration Guide
    ══════════════════════════════════════════════════════════

    ▶ Configuration Steps
    ──────────────────────────────────────────────────────────
       1. Open Chatbox application
       2. Go to Settings > MCP Server Configuration
       3. Add generated config to MCP config file
       4. Ensure MCP functionality is enabled
       5. Test connection
       6. Save settings and restart Chatbox

    ▶ Prerequisites
    ──────────────────────────────────────────────────────────
       ✓ Node.js required
       ✓ Zotero must be running

    ══════════════════════════════════════════════════════════
trae-ai-instructions =
    ══════════════════════════════════════════════════════════
      Trae AI MCP Configuration Guide
    ══════════════════════════════════════════════════════════

    ▶ Configuration Steps
    ──────────────────────────────────────────────────────────
       1. Press Ctrl+U to open Agents panel
       2. Click gear icon (AI Management)
       3. Select MCP > Configure Manually
       4. Paste generated JSON configuration
       5. Click Confirm
       6. Restart Trae application
       7. Select MCP server from Agents list

    ▶ Prerequisites
    ──────────────────────────────────────────────────────────
       ✓ Node.js required
       ✓ Zotero must be running

    ══════════════════════════════════════════════════════════
custom-http-instructions =
    ══════════════════════════════════════════════════════════
      Generic HTTP MCP Client Configuration
    ══════════════════════════════════════════════════════════

    ▶ Configuration Options
    ──────────────────────────────────────────────────────────
       • transport.type: "http"
       • transport.endpoint: MCP server address
       • transport.method: "POST"

    ▶ Usage
    ──────────────────────────────────────────────────────────
       1. Adjust config format per client requirements
       2. Ensure client supports HTTP MCP transport
       3. Use curl POST to /mcp endpoint to verify connection

    ▶ Prerequisites
    ──────────────────────────────────────────────────────────
       ✓ Zotero must be running
       ✓ Client must support Streamable HTTP transport

    ══════════════════════════════════════════════════════════
config-guide-header = # { $clientName } MCP Configuration Guide
config-guide-server-info = ## Server Information
config-guide-server-name = - **Server Name**: { $serverName }
config-guide-server-port = - **Port**: { $port }
config-guide-server-endpoint = - **Endpoint**: http://localhost:{ $port }/mcp
config-guide-json-header = ## Configuration Snippet
config-guide-steps-header = ## Configuration Steps
config-guide-tools-header = ## Available Tools
config-guide-tools-list =
    - hybrid_search - Default first step for literature discovery; keyword (metadata + indexed body) and semantic branches in parallel
    - search_library - Structured metadata search
    - get_item_details - Get item details
    - get_document_chunks - Read a paper's indexed body passages in order
    - search_fulltext - Search inside one paper; needs an itemKey from hybrid_search
    - get_collections - Get collections list
    - search_annotations - Search annotations and highlights
    - And more...
config-guide-troubleshooting-header = ## Troubleshooting
config-guide-troubleshooting-list =
    1. Ensure Zotero is running
    2. Ensure MCP server is enabled and running on specified port
    3. Check firewall settings
    4. Verify configuration file format is correct
config-guide-generated-time = Generated at: { $time }
# Context menu for indexing
menu-semantic-index = Update Index
menu-semantic-index-selected = Index Selected Items
menu-semantic-index-all = Index All Items
menu-semantic-clear-selected = Clear Selected Items Index
menu-semantic-clear-selected-confirm = Clear the search index (semantic vectors + body keywords) for the selected items?
menu-semantic-clear-selected-done = Index cleared for
menu-semantic-items = items
menu-semantic-index-started = Indexing started
menu-semantic-index-completed = Indexing completed
menu-semantic-index-busy = An index build is already running, please wait for it to finish
menu-semantic-index-error = Indexing failed
menu-semantic-index-no-collection = Please select a collection
menu-semantic-index-no-items = No indexable items
# Collection context menu
menu-collection-semantic-index = Index
menu-collection-build-index = Build Index
menu-collection-rebuild-index = Rebuild Index
menu-collection-clear-index = Clear Index
menu-collection-clear-confirm = Clear the search index (semantic vectors + body keywords) for this collection?
menu-collection-index-cleared = Index cleared
# 索引结果通知 / index result notifications
notice-index-done = Indexing finished
notice-index-nothing-new = Nothing new to index
notice-index-nothing = No indexable items found
notice-index-skipped = Already indexed, skipped
notice-index-written = Vectors rewritten for
notice-index-unchanged = Already up to date
notice-index-attached = Markdown attached to items
notice-index-preparing = Preparing…
notice-index-parsing = Parsing with MinerU
notice-index-embedding = Writing vectors…
notice-index-failed = Failed items
notice-index-body-failed = Indexed without full text (body parse failed)
notice-index-body-failed-hint = title and abstract only; retried automatically, and excluded from full-text search
notice-index-zero-hint = Nothing was written: no text could be extracted from the attachments.
notice-mineru-failed = High-precision MinerU text unavailable
notice-mineru-fallback = built-in PDF extraction was used instead of high-precision MinerU text; fix MinerU and rebuild the index
notice-index-no-selection = Nothing selected
notice-index-no-eligible = Nothing indexable in the selection
notice-index-no-eligible-hint = Select a bibliography item, or an attachment that belongs to one.
