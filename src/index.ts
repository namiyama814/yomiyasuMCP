import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { executeTool, readBounded, schemas, type Env, type ToolName } from './tools';

const descriptions: Record<ToolName, string> = {
  get_instructions: 'yomiyasuで日本語を推敲する前に呼ぶ。指示書・MCP手順・参照資料ID・上流バージョンを取得する。',
  get_reference: '指示書が指定する文書種別・読み手別などの資料をIDで取得する。',
  lint: '原文または推敲後本文の見直し候補を検査する。本文はCloudflareに送信される。候補は品質の点数ではない。',
  check: '原文と推敲後本文のlint・diffと任意の資料照合を実行し、署名付きレシートを返す。本文はCloudflareに送信される。',
  verify: '提出本文と最後のcheckのレシートを照合する。matches=trueの後は本文を変更せず提出する。',
};
function server(env: Env) {
  const mcp = new McpServer({ name: 'yomiyasu', version: '0.1.0' });
  for (const name of Object.keys(schemas) as ToolName[]) {
    mcp.registerTool(name, {
      description: descriptions[name], inputSchema: schemas[name],
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (args: unknown) => {
      try {
        const result = await executeTool(name, args, env);
        const serialized = JSON.stringify(result);
        // Return all results or an explicit error; never silently truncate findings.
        if (new TextEncoder().encode(serialized).length > 4 * 1024 * 1024) throw new Error('tool_result_too_large');
        return { content: [{ type: 'text' as const, text: serialized }], structuredContent: result };
      } catch (error) {
        const safe = error instanceof Error && /^[a-zA-Z0-9_]+$/.test(error.message) ? error.message : 'invalid_input_or_tool_failed';
        return { isError: true, content: [{ type: 'text' as const, text: safe }] };
      }
    });
  }
  return mcp;
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ status: 'ok', version: '0.1.0' }, { headers: { 'Cache-Control': 'no-store' } });
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    if (request.method === 'POST') {
      let body: Uint8Array;
      try { body = await readBounded(request.body, 1024 * 1024); }
      catch { return new Response('Request too large', { status: 413 }); }
      request = new Request(request.url, { method: request.method, headers: request.headers, body: new Uint8Array(body).buffer });
    }
    const response = await createMcpHandler(() => server(env))(request, env, ctx);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  },
} satisfies ExportedHandler<Env>;
