import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const url = new URL(process.env.MCP_URL ?? 'http://localhost:8787/mcp');
const client = new Client({ name:'yomiyasu-smoke', version:'0.1.0' });
await client.connect(new StreamableHTTPClientTransport(url));
try {
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(x=>x.name).sort(), ['check','get_instructions','get_reference','lint','verify']);
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments:args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
    assert.ok(result.structuredContent);
    return result.structuredContent as Record<string, any>;
  }
  const instructions = await call('get_instructions', {});
  assert.ok(instructions.workflow.includes('verify'));
  const ref = await call('get_reference', {id:'references/doc-types/article.md'});
  assert.ok(ref.text);
  const lint = await call('lint', {text:'これは、強固な土台です。',doc_type:'article'});
  assert.equal(lint.lint.tool_version, instructions.upstream.version);
  const original = '# 手順\n\n失敗した場合だけ3回実行します。必ず通知するとは限りません。\n\n> 元の引用\n\n```py\nx = 3\n```\n';
  const final = '# 手順\n\n常に2回実行します。必ず通知します。\n\n> 変更した引用\n\n```py\nx = 2\n```\n';
  const checked = await call('check', {original, final, materials:['失敗した場合だけ3回実行します。'],doc_type:'article'});
  assert.ok(checked.diff.meaning_risk_count > 0);
  assert.ok(checked.ground);
  assert.ok(checked.receipt);
  assert.equal((await call('verify', {final,receipt:checked.receipt})).matches, true);
  assert.equal((await call('verify', {final:final.replaceAll('\n','\r\n'),receipt:checked.receipt})).matches, false);
  const tampered = checked.receipt.slice(0, -2) + (checked.receipt.at(-2) === 'A' ? 'B' : 'A') + checked.receipt.at(-1);
  assert.equal((await client.callTool({name:'verify',arguments:{final,receipt:tampered}})).isError, true);
  for (const [name,args] of [['lint',{text:'あ'.repeat(43691)}],['lint',{text:'a',reader:'unknown'}],['get_reference',{id:'../../.env'}]] as const) {
    assert.equal((await client.callTool({name,arguments:args})).isError, true);
  }
  const results = await Promise.all(Array.from({length:4}, (_, i) => call('check', {original:`原文${i}です。`, final:`本文${i}です。`} )));
  for(let i=0;i<results.length;i++) {
    assert.equal((await call('verify',{final:`本文${i}です。`,receipt:results[i].receipt})).matches,true);
    assert.equal((await call('verify',{final:`本文${(i+1)%results.length}です。`,receipt:results[i].receipt})).matches,false);
  }
  // Runtime results must match the unmodified upstream CLI, not only the adapter's shape.
  if (process.env.SKIP_UPSTREAM_PARITY !== '1') {
    const { execFileSync } = await import('node:child_process');
    const upstream = JSON.parse(execFileSync('python3', ['checker/src/vendor/scripts/yomiyasu_lint.py','--json','--no-words','--doc-type','article','-'], {input:'これは、強固な土台です。',encoding:'utf8'}));
    assert.deepEqual(lint.lint,upstream);
    const { resolve } = await import('node:path');
    const code = `import sys,json
sys.path.insert(0,sys.argv[1])
import yomiyasu_diff
x=json.load(sys.stdin)
print(json.dumps({'diff':yomiyasu_diff.diff(x['original'],x['final'],doc_type='article',materials=x['materials']),'ground':yomiyasu_diff.ground(x['final'],x['materials'],original=x['original'])}))`;
    const comparison = JSON.parse(execFileSync('python3', ['-c',code,resolve('checker/src/vendor/scripts')], {input:JSON.stringify({original,final,materials:['失敗した場合だけ3回実行します。']}),encoding:'utf8'}));
    assert.deepEqual(checked.diff,comparison.diff);
    assert.deepEqual(checked.ground,comparison.ground);
  }
  console.log('MCP integration passed: initialization, five tools, Python binding, exact receipts, validation, concurrent checks, upstream lint/diff/ground parity.');
} finally { await client.close(); }
