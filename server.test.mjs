import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { createBrowserbasePlugin } from './server.ts';

const success = (data) => ({ content: [{ type: 'text', text: JSON.stringify({ success: true, data }) }] });
function fixture(options = {}) {
  const calls = [];
  const clients = [];
  const host = createFakePluginHost({ pluginId: 'browserbase', settings: options.noKey ? {} : { apiKey: 'test-private-key' } });
  const connect = async (key, signal) => {
    signal.throwIfAborted();
    const id = `session-${clients.length + 1}`;
    const state = { id, key, active: 0, maximum: 0, closed: false };
    clients.push(state);
    return {
      async callTool(params, schema, request) {
        request.signal?.throwIfAborted();
        state.maximum = Math.max(state.maximum, ++state.active);
        calls.push({ id, name: params.name, args: params.arguments, key });
        try {
          await new Promise(resolve => setTimeout(resolve, 2));
          if (options.handler) {
            const result = await options.handler(params, id);
            if (result) return result;
          }
          if (params.name === 'start') return success({ sessionId: id });
          return success({ tool: params.name });
        } finally { state.active--; }
      },
      async close() { state.closed = true; },
    };
  };
  createBrowserbasePlugin(connect)(host.bb);
  return {
    ...host, calls, clients,
    call: (name, args = {}, threadId = 'thread-a') => host.harness.behavior.callAgentTool(`browserbase_${name}`, args, { threadId }),
  };
}

test('missing credentials produces setup guidance without connecting', async () => {
  const f = fixture({ noKey: true });
  try {
    const result = await f.call('start');
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Settings/);
    assert.equal(f.clients.length, 0);
  } finally { await f.harness.lifecycle.dispose(); }
});

test('threads are isolated, repeated start reuses, and IDs are forwarded', async () => {
  const f = fixture();
  try {
    await Promise.all([f.call('start'), f.call('start', {}, 'thread-b')]);
    await f.call('start');
    await f.call('navigate', { url: 'https://example.com' });
    await f.call('extract', {}, 'thread-b');
    assert.equal(f.clients.length, 2);
    assert.equal(f.calls.filter(c => c.name === 'start').length, 2);
    assert.equal(f.calls.find(c => c.name === 'navigate').args.sessionId, 'session-1');
    assert.equal(f.calls.find(c => c.name === 'extract').args.sessionId, 'session-2');
    await f.call('end');
    assert.equal(f.clients[0].closed, true);
    assert.equal(f.clients[1].closed, false);
  } finally { await f.harness.lifecycle.dispose(); }
  assert.equal(f.clients[1].closed, true);
});

test('same-thread calls serialize and invalid URLs or session overrides are rejected', async () => {
  const f = fixture();
  try {
    await Promise.all([f.call('start'), f.call('start')]);
    await Promise.all([f.call('observe', { instruction: 'Find search' }), f.call('act', { action: 'Click search' })]);
    assert.equal(f.clients.length, 1);
    assert.equal(f.clients[0].maximum, 1);
    await assert.rejects(f.call('navigate', { url: 'file:///etc/passwd' }));
    await assert.rejects(f.call('extract', { sessionId: 'someone-else' }));
  } finally { await f.harness.lifecycle.dispose(); }
});

test('upstream errors stay errors and secrets are redacted', async () => {
  const f = fixture({ handler: params => params.name === 'extract' ? {
    isError: true, content: [{ type: 'text', text: 'Denied: test-private-key' }],
  } : undefined });
  try {
    await f.call('start');
    const result = await f.call('extract');
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /test-private-key/);
  } finally { await f.harness.lifecycle.dispose(); }
});

test('failed actions are not retried and thrown URLs are not exposed', async () => {
  const f = fixture({ handler: params => {
    if (params.name === 'act') throw Error('https://example.com/?key=test-private-key');
  } });
  try {
    await f.call('start');
    const result = await f.call('act', { action: 'Click submit' });
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /test-private-key/);
    assert.equal(f.calls.filter(c => c.name === 'act').length, 1);
  } finally { await f.harness.lifecycle.dispose(); }
});

test('key rotation requires ending the old session with its original connection', async () => {
  const f = fixture();
  try {
    await f.call('start');
    await f.harness.behavior.setSettings({ apiKey: 'replacement-key' });
    assert.equal((await f.call('start')).isError, true);
    await f.call('end');
    assert.equal(f.calls.find(c => c.name === 'end').key, 'test-private-key');
    await f.call('start');
    assert.equal(f.clients[1].key, 'replacement-key');
  } finally { await f.harness.lifecycle.dispose(); }
});

test('archiving ends only the matching session', async () => {
  const f = fixture();
  try {
    await f.call('start');
    await f.call('start', {}, 'thread-b');
    await f.harness.behavior.emitThreadEvent('thread.archived', { thread: makeThreadResponse({ id: 'thread-a' }) });
    assert.equal(f.clients[0].closed, true);
    assert.equal(f.clients[1].closed, false);
  } finally { await f.harness.lifecycle.dispose(); }
});

test('unrecognized start response attempts cleanup rather than leaking a reusable default', async () => {
  const f = fixture({ handler: params => params.name === 'start' ? success({ changedSchema: true }) : undefined });
  try {
    assert.equal((await f.call('start')).isError, true);
    assert.equal(f.clients[0].closed, true);
    assert.equal(f.calls.filter(c => c.name === 'end').length, 1);
    assert.equal((await f.call('extract')).isError, true);
  } finally { await f.harness.lifecycle.dispose(); }
});

test('structured session IDs and bounded extraction output work', async () => {
  const f = fixture({ handler: (params, id) => params.name === 'start' ? {
    content: [], structuredContent: { sessionId: id },
  } : params.name === 'extract' ? { content: [{ type: 'text', text: 'x'.repeat(100_000) }] } : undefined });
  try {
    await f.call('start');
    const result = await f.call('extract');
    assert.ok(result.content[0].text.length < 50_000);
    assert.match(result.content[0].text, /truncated/);
  } finally { await f.harness.lifecycle.dispose(); }
});
