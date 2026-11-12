import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeTool, enforceTextLimit, readBounded, type Env } from '../src/tools';
import { upstream } from '../src/generated';
import { sha256 } from '../src/receipt';
const secret = 'test-only-32-byte-secret-for-receipts';
function envWith(fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): Env {
  return { RECEIPT_SECRET: secret, CHECKER: { fetch } as unknown as Fetcher };
}
const env = envWith(async (_url, init) => {
  const data = JSON.parse(init!.body as string);
  return Response.json({ status: 'completed', upstream, original_lint: {}, final_lint: {}, diff: {}, ground: data.materials?.length ? {} : null,
    hashes: { original: await sha256(data.original), final: await sha256(data.final), materials: await Promise.all((data.materials ?? []).map(sha256)) } });
});
test('signed receipts match exact text, reject tampering and key rotation', async () => {
  const checked = await executeTool('check', { original:'元の文', final:'本文\r\n', materials:['資料'], doc_type:'article' }, env);
  assert.equal((await executeTool('verify', { final:'本文\r\n', receipt: checked.receipt }, env)).matches, true);
  for (const final of ['本文\n', '本文', '変更\r\n']) assert.equal((await executeTool('verify', { final, receipt: checked.receipt }, env)).matches, false);
  const parts = checked.receipt.split('.');
  const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  assert.equal(payload.conditions.doc_type, 'article');
  assert.equal(JSON.stringify(payload).includes('本文'), false);
  payload.final_hash = await sha256('偽の文');
  await assert.rejects(executeTool('verify', { final:'偽の文', receipt:Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + parts[1] }, env), /invalid_receipt/);
  await assert.rejects(executeTool('verify', { final:'本文\r\n', receipt:checked.receipt }, { ...env, RECEIPT_SECRET:'different-secret-at-least-32-characters' }), /invalid_receipt/);
});
test('concurrent checks cannot exchange receipts', async () => {
  const pairs = await Promise.all(Array.from({length:8}, async (_, i) => {
    const final = `本文${i}`;
    const result = await executeTool('check', { original:`原文${i}`, final }, env);
    return { final, receipt:result.receipt };
  }));
  for (let i=0;i<pairs.length;i++) {
    assert.equal((await executeTool('verify', pairs[i], env)).matches, true);
    assert.equal((await executeTool('verify', { ...pairs[i], final:pairs[(i+1)%pairs.length].final }, env)).matches, false);
  }
});
test('strict input validation and UTF-8 size limits', async () => {
  enforceTextLimit(['a'.repeat(131072)]);
  assert.throws(() => enforceTextLimit(['あ'.repeat(43691)]));
  assert.throws(() => enforceTextLimit(['a'.repeat(70000),'b'.repeat(70000)]));
  for (const args of [{text:'a', doc_type:'invalid'}, {text:'a', extra:1}, {text:'\ud800'}]) await assert.rejects(executeTool('lint', args, env));
  await assert.rejects(executeTool('get_reference', {id:'__proto__'}, env), /unknown_reference/);
  await assert.rejects(executeTool('get_reference', {id:'../../.env'}, env), /unknown_reference/);
  const instructions = await executeTool('get_instructions', {}, env);
  assert.ok(instructions.skill.includes('意味の保持'));
  assert.ok((await executeTool('get_reference', {id:'references/doc-types/article.md'}, env)).text);
});
test('failed or incomplete checker responses never produce a receipt', async () => {
  for (const response of [new Response('error',{status:500}), Response.json({status:'completed',upstream}), new Response('bad json'), Response.json({status:'completed',upstream,original_lint:{},final_lint:{},diff:{},hashes:{final:'wrong'}})]) {
    await assert.rejects(executeTool('check', {original:'a',final:'b'}, envWith(async () => response)));
  }
  await assert.rejects(executeTool('check', {original:'a',final:'b'}, {...env, RECEIPT_SECRET:''}), /receipt_secret/);
  await assert.rejects(readBounded(new Response('12345').body,4), /too_large/);
});
