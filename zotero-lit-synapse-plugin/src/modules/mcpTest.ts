/**
 * MCP Integration Test Module
 * 
 * Tests the integrated MCP server functionality
 */
import { MCP_PROTOCOL_VERSION } from './mcpTransport';

export interface MCPTestResult {
  testName: string;
  status: 'PASSED' | 'FAILED';
  duration: number;
  result?: any;
  error?: string;
}

export async function testMCPIntegration(): Promise<{
  message: string;
  message_zh: string;
  testResults: {
    summary: {
      total: number;
      passed: number;
      failed: number;
      successRate: string;
    };
    tests: MCPTestResult[];
    timestamp: string;
  };
}> {
  const tests: MCPTestResult[] = [];
  const startTime = Date.now();

  // Test 1: MCP Initialize
  await runTest('MCP Initialize', async () => {
    const request = {
      jsonrpc: '2.0' as const,
      id: 'test-1',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: {
          name: 'test-client',
          version: '1.0.0'
        }
      }
    };

    // Simulate the MCP server logic
    const { StreamableMCPServer } = await import('./streamableMCPServer');
    const mcpServer = new StreamableMCPServer();
    
    // Test the initialize method through private access
    const response = await (mcpServer as any).processRequest(request);
    
    // The instructions are the retrieval funnel's only description for a
    // client that reads nothing else, so the self-test pins the three stages
    // and the rule that separates them: abstracts are fetched on demand,
    // never shipped with the candidate list.
    const instructions: string = response.result?.instructions || '';
    const describesFunnel =
      instructions.includes('hybrid_search') &&
      instructions.includes('get_item_abstract') &&
      instructions.includes('search_fulltext') &&
      instructions.includes('Abstracts are deliberately NOT included');

    if (
      response.result &&
      response.result.protocolVersion === MCP_PROTOCOL_VERSION &&
      describesFunnel
    ) {
      return { success: true, response };
    } else {
      throw new Error(
        describesFunnel
          ? 'Invalid initialize response'
          : 'Instructions no longer describe the hybrid_search -> get_item_abstract -> search_fulltext funnel',
      );
    }
  }, tests);

  // Test 2: Tools List
  await runTest('Tools List', async () => {
    const request = {
      jsonrpc: '2.0' as const,
      id: 'test-2',
      method: 'tools/list',
      params: {}
    };

    const { StreamableMCPServer } = await import('./streamableMCPServer');
    const mcpServer = new StreamableMCPServer();
    
    const response = await (mcpServer as any).processRequest(request);
    
    if (response.result && response.result.tools && Array.isArray(response.result.tools)) {
      const tools = response.result.tools;
      const expectedTools = ['hybrid_search', 'search_library', 'search_annotations', 'get_item_details'];
      const hasExpectedTools = expectedTools.every(tool => 
        tools.some((t: any) => t.name === tool)
      );
      const hybridIsFirst = tools[0]?.name === 'hybrid_search';
      const librarySearch = tools.find((tool: any) => tool.name === 'search_library');
      const fulltextSearch = tools.find((tool: any) => tool.name === 'search_fulltext');
      const libraryHasNoFulltext =
        !Object.prototype.hasOwnProperty.call(
          librarySearch?.inputSchema?.properties || {},
          'fulltext',
        );
      // search_fulltext is a single-document deep dive now: one itemKey per
      // call, so the AI has to re-think the query for each paper.
      const fulltextRequiresItemKey =
        fulltextSearch?.inputSchema?.required?.includes('itemKey') === true;

      // Stage 1 must advertise that it does not return abstracts, and the
      // on-demand fetch must advertise that it is not a batch step. Two tools
      // describing the same boundary in opposite ways is how a caller ends up
      // reading 20 abstracts to pick 3.
      const hybridSearch = tools.find((tool: any) => tool.name === 'hybrid_search');
      const abstractTool = tools.find((tool: any) => tool.name === 'get_item_abstract');
      const hybridDeclaresNoAbstracts =
        typeof hybridSearch?.description === 'string' &&
        hybridSearch.description.includes('ABSTRACTS ARE NOT RETURNED');
      const abstractIsOnDemand =
        typeof abstractTool?.description === 'string' &&
        abstractTool.description.includes('on-demand');

      // Paging has to be reachable from the tool schema, or documents past
      // the first page stay invisible no matter how the ranking is built.
      const hybridOffersCursor = Object.prototype.hasOwnProperty.call(
        hybridSearch?.inputSchema?.properties || {},
        'cursor',
      );

      if (
        hasExpectedTools &&
        hybridIsFirst &&
        libraryHasNoFulltext &&
        fulltextRequiresItemKey &&
        hybridDeclaresNoAbstracts &&
        abstractIsOnDemand &&
        hybridOffersCursor
      ) {
        return { success: true, toolCount: tools.length, tools: tools.map((t: any) => t.name) };
      } else {
        throw new Error(
          'Invalid hybrid-first tool contract',
        );
      }
    } else {
      throw new Error('Invalid tools list response');
    }
  }, tests);

  // Test 3: Full-text search must be scoped before touching Zotero content
  await runTest('Scoped Full-text Required', async () => {
    const request = {
      jsonrpc: '2.0' as const,
      id: 'test-3',
      method: 'tools/call',
      params: {
        name: 'search_fulltext',
        arguments: { q: 'evidence' }
      }
    };

    const { StreamableMCPServer } = await import('./streamableMCPServer');
    const mcpServer = new StreamableMCPServer();
    const response = await (mcpServer as any).processRequest(request);

    if (
      response.error?.message?.includes(
        'itemKey from hybrid_search is required',
      )
    ) {
      return { success: true, error: response.error };
    }
    throw new Error('Unscoped full-text search was not rejected');
  }, tests);

  // Test 4: Ping
  //
  // ping is a JSON-RPC method in the MCP lifecycle, not a tool: it is answered
  // by processRequest itself and never appears in tools/list. This test used to
  // send it as tools/call, which the server has always rejected — a permanent
  // self-test failure that said nothing about the server.
  await runTest('Ping', async () => {
    const request = {
      jsonrpc: '2.0' as const,
      id: 'test-3',
      method: 'ping',
      params: {}
    };

    const { StreamableMCPServer } = await import('./streamableMCPServer');
    const mcpServer = new StreamableMCPServer();
    
    const response = await (mcpServer as any).processRequest(request);
    
    if (response.result) {
      return { success: true, response: response.result };
    } else {
      throw new Error('Ping method call failed');
    }
  }, tests);

  // Test 4: MCP Status
  await runTest('MCP Server Status', async () => {
    const { StreamableMCPServer } = await import('./streamableMCPServer');
    const mcpServer = new StreamableMCPServer();
    
    const status = mcpServer.getStatus();

    if (!status.serverInfo || !status.protocolVersion || !status.availableTools) {
      throw new Error('Invalid status response');
    }

    // A truthiness check is what let getStatus() drift out of sync with
    // tools/list in the first place: it reported six fewer tools than the
    // server served and nothing failed. Compare the two lists instead.
    const listed = await (mcpServer as any).processRequest({
      jsonrpc: '2.0' as const,
      id: 'test-4-tools',
      method: 'tools/list',
      params: {}
    });
    const served: string[] = (listed?.result?.tools ?? []).map((t: any) => t.name);
    const advertised: string[] = status.availableTools;

    const missing = served.filter((n) => !advertised.includes(n));
    const phantom = advertised.filter((n) => !served.includes(n));
    if (missing.length || phantom.length) {
      throw new Error(
        `availableTools disagrees with tools/list — ` +
        `served but not advertised: [${missing.join(', ')}]; ` +
        `advertised but not served: [${phantom.join(', ')}]`
      );
    }

    return { success: true, status, toolCount: served.length };
  }, tests);

  // Test 5: Error Handling
  await runTest('Error Handling', async () => {
    const request = {
      jsonrpc: '2.0' as const,
      id: 'test-5',
      method: 'invalid/method',
      params: {}
    };

    const { StreamableMCPServer } = await import('./streamableMCPServer');
    const mcpServer = new StreamableMCPServer();
    
    const response = await (mcpServer as any).processRequest(request);
    
    if (response.error && response.error.code === -32601) {
      return { success: true, error: response.error };
    } else {
      throw new Error('Error handling failed');
    }
  }, tests);

  // Test 6: notifications/initialized (no id) should return 202 with empty body
  await runTest('Initialized Notification (no id)', async () => {
    const { StreamableMCPServer } = await import('./streamableMCPServer');
    const mcpServer = new StreamableMCPServer();

    const response = await mcpServer.handleMCPRequest(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    }));

    if (response.status === 202 && response.body === '') {
      return { success: true, response };
    } else {
      throw new Error(`Expected 202 with empty body, got status=${response.status}, bodyLength=${response.body.length}`);
    }
  }, tests);

  // Test 7: Legacy initialized request with id remains compatible
  await runTest('Legacy initialized with id', async () => {
    const { StreamableMCPServer } = await import('./streamableMCPServer');
    const mcpServer = new StreamableMCPServer();

    const response = await mcpServer.handleMCPRequest(JSON.stringify({
      jsonrpc: '2.0',
      id: 'test-7',
      method: 'initialized',
      params: {}
    }));

    if (response.status !== 200) {
      throw new Error(`Expected status 200, got ${response.status}`);
    }

    const payload = JSON.parse(response.body);
    if (payload.result?.success === true) {
      return { success: true, response: payload };
    } else {
      throw new Error('Legacy initialized response missing success=true');
    }
  }, tests);

  // Test 8: Request method without id should return invalid request
  await runTest('Invalid Request - Missing id', async () => {
    const { StreamableMCPServer } = await import('./streamableMCPServer');
    const mcpServer = new StreamableMCPServer();

    const response = await mcpServer.handleMCPRequest(JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {}
    }));

    if (response.status !== 400) {
      throw new Error(`Expected status 400, got ${response.status}`);
    }

    const payload = JSON.parse(response.body);
    if (payload.error?.code === -32600 && payload.id === null) {
      return { success: true, response: payload };
    } else {
      throw new Error(`Expected -32600 with id=null, got: ${response.body}`);
    }
  }, tests);

  // Test 9: Batch requests should be rejected
  await runTest('Invalid Request - Batch not supported', async () => {
    const { StreamableMCPServer } = await import('./streamableMCPServer');
    const mcpServer = new StreamableMCPServer();

    const response = await mcpServer.handleMCPRequest(JSON.stringify([
      {
        jsonrpc: '2.0',
        id: 'test-9',
        method: 'ping',
        params: {}
      }
    ]));

    if (response.status !== 400) {
      throw new Error(`Expected status 400, got ${response.status}`);
    }

    const payload = JSON.parse(response.body);
    if (payload.error?.code === -32600 && payload.id === null) {
      return { success: true, response: payload };
    } else {
      throw new Error(`Expected batch rejection -32600 with id=null, got: ${response.body}`);
    }
  }, tests);

  const endTime = Date.now();
  const duration = endTime - startTime;

  const summary = {
    total: tests.length,
    passed: tests.filter(t => t.status === 'PASSED').length,
    failed: tests.filter(t => t.status === 'FAILED').length,
    successRate: `${((tests.filter(t => t.status === 'PASSED').length / tests.length) * 100).toFixed(1)}%`
  };

  ztoolkit.log(`[MCPTest] Completed ${tests.length} tests in ${duration}ms: ${summary.passed} passed, ${summary.failed} failed`);

  return {
    message: "MCP integration test completed",
    message_zh: "MCP集成测试完成",
    testResults: {
      summary,
      tests,
      timestamp: new Date().toISOString()
    }
  };
}

async function runTest(
  testName: string,
  testFunction: () => Promise<any>,
  tests: MCPTestResult[]
): Promise<void> {
  const startTime = Date.now();
  try {
    ztoolkit.log(`[MCPTest] Running: ${testName}`);
    const result = await testFunction();
    const duration = Date.now() - startTime;
    
    tests.push({
      testName,
      status: 'PASSED',
      duration,
      result
    });
    
    ztoolkit.log(`[MCPTest] ✓ ${testName} passed in ${duration}ms`);
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    tests.push({
      testName,
      status: 'FAILED',
      duration,
      error: errorMessage
    });
    
    ztoolkit.log(`[MCPTest] ✗ ${testName} failed in ${duration}ms: ${errorMessage}`);
  }
}
