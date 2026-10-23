import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http2 from 'node:http2';
import { fileURLToPath } from 'node:url';
import { Writer, grpcFrame, decodeFields } from '../../lib/wire.js';
import { parseUsageInfo } from './parse.mjs';

const float = n => {
  const b = Buffer.alloc(4); b.writeFloatLE(n); return b.readUInt32LE();
};
function response(value, { type = 1, reset = true, nanos = 123456789 } = {}) {
  const usage = new Writer();
  if (value !== undefined) usage.fixed32(2, float(value));
  if (reset) usage.message(1, new Writer().varint(1, 1792532809).varint(2, nanos));
  return new Writer().message(3, new Writer().varint(1, type).message(2, usage)).finish();
}
for (const fraction of [0, 1, .25]) {
  const [pool] = parseUsageInfo(response(fraction));
  assert.equal(pool.usedPercent, fraction * 100);
  assert.equal(pool.remainingPercent, (1 - fraction) * 100);
  assert.equal(pool.resetAt, '2026-10-20T21:46:49.123456789Z');
}
for (const value of [undefined, NaN, Infinity, -.1, 1.1]) {
  const [pool] = parseUsageInfo(response(value, { reset: false }));
  assert.equal(pool.usedPercent, null);
  assert.equal(pool.remainingPercent, null);
  assert.equal(pool.resetAt, null);
}
assert.equal(parseUsageInfo(response(.5, { type: 2 }))[0].type, 'weekly');
assert.equal(parseUsageInfo(response(.5, { nanos: 1000000000 }))[0].resetAt, null);
assert.deepEqual(parseUsageInfo(response(.5, { type: 3 })), []);
assert.deepEqual(parseUsageInfo(response(.5, { type: 99 })), []);
assert.deepEqual(parseUsageInfo(new Uint8Array()), []);
assert.throws(() => parseUsageInfo(response(.5).subarray(0, -1)));
assert.throws(() => parseUsageInfo(Uint8Array.of(26, 10, 0)));
assert.throws(() => parseUsageInfo(Uint8Array.of(0)));
const creditsLast = new Writer().message(3, new Writer().varint(1, 1)
  .message(2, new Writer().fixed32(2, float(.5))).message(3, new Writer())).finish();
assert.deepEqual(parseUsageInfo(creditsLast), []);

function cli(args, url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./query.mjs', import.meta.url)), ...args], {
      env: { ...process.env, ROBIN_URL: url, GSA_EMAIL: '', GSA_MASTER_TOKEN: '', TOKEN_PROVIDER_URL: '', ROBIN_AUTH_TOKEN: '', ROBIN_EXTRA_HEADERS: '{}' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b);
    child.stderr.on('data', b => stderr += b);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr, json: JSON.parse(stdout) }));
  });
}
const server = http2.createServer();
let calls = 0, fail = false, malformed = false;
server.on('stream', (stream, headers) => {
  calls++;
  assert.equal(headers[':path'], '/assistant.mobile.robin.RobinService/GetUsageInfo');
  const chunks = [];
  stream.on('data', b => chunks.push(b));
  stream.on('end', () => {
    const framed = Buffer.concat(chunks);
    const request = decodeFields(framed.subarray(5));
    assert.equal(request[0].no, 1);
    assert.equal(decodeFields(request[0].value).find(f => f.no === 4).value, 2n);
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': fail ? '7' : '0', 'grpc-message': 'SECRET_UPSTREAM_DIAGNOSTIC' }));
    stream.end(grpcFrame(malformed ? Uint8Array.of(26, 100) : response(.25)));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await cli([], url)).json, { enabled: false });
  assert.equal((await cli(['--wrong'], url)).code, 2);
  assert.equal(calls, 0, 'disabled/invalid flags must not issue requests');
  const success = await cli(['--enable'], url);
  assert.equal(success.code, 0, success.stdout + success.stderr);
  assert.equal(success.json.pools[0].remainingPercent, 75);
  assert.equal(success.stderr, '');
  fail = true;
  const failure = await cli(['--enable'], url);
  assert.equal(failure.code, 1);
  assert.equal(failure.json.grpcStatus, '7');
  assert.ok(!failure.stdout.includes('SECRET'));
  assert.equal(failure.stderr, '');
  fail = false; malformed = true;
  const bad = await cli(['--enable'], url);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.error, 'query_or_decode_failed');
  assert.equal(calls, 3);
} finally { server.close(); }
console.log('usage-info: parser, opt-in CLI and mock RPC checks passed');
