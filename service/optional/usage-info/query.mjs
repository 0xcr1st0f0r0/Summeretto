// An explicit, isolated CLI: never imported by the gateway or its startup path.
const args = process.argv.slice(2);
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (args.length === 0) {
  emit({ enabled: false });
} else if (args.length !== 1 || args[0] !== '--enable') {
  emit({ ok: false, error: 'usage: node optional/usage-info/query.mjs [--enable]' });
  process.exitCode = 2;
} else {
  // Existing auth/transport modules log upstream errors. This standalone process
  // suppresses those logs so stdout is JSON and neither output stream leaks secrets.
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) console[method] = () => {};
  const watchdog = setTimeout(() => {
    emit({ ok: false, error: 'query_timeout' });
    process.exit(1);
  }, 60_000);
  let close;
  try {
    const { unaryRpc, closeRobinSession } = await import('../../lib/robin.js');
    close = closeRobinSession;
    const { buildLgauy } = await import('../../lib/pq.js');
    const { Writer } = await import('../../lib/wire.js');
    const { parseUsageInfo } = await import('./parse.mjs');
    const request = new Writer().message(1, buildLgauy({ enum4: 2 })).finish();
    const result = await unaryRpc('GetUsageInfo', request, { timeoutMs: 20_000 });
    if (!result.ok || result.error || !result.body) {
      emit({ ok: false, error: 'query_failed', grpcStatus: /^\d{1,2}$/.test(String(result.grpcStatus)) ? String(result.grpcStatus) : null });
      process.exitCode = 1;
    } else {
      emit({ ok: true, source: 'GetUsageInfo', checkedAt: new Date().toISOString(), pools: parseUsageInfo(result.body) });
    }
  } catch {
    emit({ ok: false, error: 'query_or_decode_failed' });
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    close?.();
  }
}
