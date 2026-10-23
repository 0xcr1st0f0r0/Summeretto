import { readVarint } from '../../lib/wire.js';

// Strict bounds checks: a truncated message must never turn into a quota value.
function fields(bytes) {
  const out = [];
  let p = 0;
  while (p < bytes.length) {
    let tag, value;
    [tag, p] = readVarint(bytes, p);
    const no = Number(tag >> 3n), wt = Number(tag & 7n);
    if (!no) throw new Error('invalid field');
    if (wt === 0) [value, p] = readVarint(bytes, p);
    else {
      let size;
      if (wt === 2) {
        let length;
        [length, p] = readVarint(bytes, p);
        if (length > BigInt(bytes.length - p)) throw new Error('truncated field');
        size = Number(length);
      } else if (wt === 1) size = 8;
      else if (wt === 5) size = 4;
      else throw new Error('unsupported wire type');
      if (p + size > bytes.length) throw new Error('truncated field');
      value = bytes.subarray(p, p + size);
      p += size;
    }
    out.push({ no, wt, value });
  }
  return out;
}

const last = (fs, no, wt) => fs.filter(f => f.no === no && f.wt === wt).at(-1)?.value;

function timestamp(bytes) {
  if (!bytes) return null;
  const fs = fields(bytes);
  // Scalar defaults inside a present protobuf Timestamp are zero.
  const seconds = BigInt.asIntN(64, last(fs, 1, 0) ?? 0n);
  const nanos = BigInt.asIntN(32, last(fs, 2, 0) ?? 0n);
  if (seconds < -62135596800n || seconds > 253402300799n || nanos < 0n || nanos > 999999999n) return null;
  const iso = new Date(Number(seconds) * 1000).toISOString();
  return iso.replace('.000Z', `.${String(nanos).padStart(9, '0')}Z`);
}

/** GetUsageInfo response #3 -> pool #2 -> fraction/reset message. */
export function parseUsageInfo(bytes) {
  const pools = [];
  for (const entry of fields(bytes).filter(f => f.no === 3 && f.wt === 2)) {
    const pool = fields(entry.value);
    const type = last(pool, 1, 0);
    if (type !== 1n && type !== 2n) continue; // Credits/unknown pools have different semantics.
    // #2 and #3 are a oneof; honor its last member, including credits.
    const usage = pool.filter(f => (f.no === 2 || f.no === 3) && f.wt === 2).at(-1);
    if (usage?.no !== 2) continue;
    const fs = fields(usage.value);
    const raw = last(fs, 2, 5);
    const fraction = raw ? new DataView(raw.buffer, raw.byteOffset, 4).getFloat32(0, true) : null;
    // Missing is unknown, rather than assuming the proto scalar default is evidence of 0% use.
    const valid = fraction !== null && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1;
    pools.push({
      type: type === 1n ? 'five_hour' : 'weekly',
      usedPercent: valid ? fraction * 100 : null,
      remainingPercent: valid ? (1 - fraction) * 100 : null,
      resetAt: timestamp(last(fs, 1, 2)),
    });
  }
  return pools;
}
