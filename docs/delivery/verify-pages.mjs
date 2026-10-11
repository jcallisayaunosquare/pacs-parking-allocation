/**
 * Finds pages with (almost) nothing drawn on them.
 *
 * A PDF page's marks live in its content stream, so a page whose decompressed stream is
 * a few hundred bytes is carrying the running header and nothing else. That is what a
 * blank page looks like from the inside, and counting them is how you tell whether a
 * pagination change actually removed any.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

for (const name of process.argv.slice(2)) {
  const raw = readFileSync(name).toString('latin1');

  // Objects, by number, so a page can be followed to its /Contents stream.
  const objects = new Map();
  for (const m of raw.matchAll(/(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g)) {
    objects.set(Number(m[1]), m[2]);
  }

  const sizes = [];
  for (const [, body] of objects) {
    if (!/\/Type\s*\/Page[^s]/.test(body)) continue;
    const ref = body.match(/\/Contents\s+(\d+)\s+0\s+R/);
    if (!ref) {
      sizes.push(0);
      continue;
    }
    const target = objects.get(Number(ref[1])) ?? '';
    const s = target.indexOf('stream');
    const e = target.indexOf('endstream');
    if (s < 0 || e < 0) {
      sizes.push(0);
      continue;
    }
    const data = target.slice(target.indexOf('\n', s) + 1, e);
    let len = 0;
    try {
      len = inflateSync(Buffer.from(data, 'latin1')).length;
    } catch {
      len = data.length;
    }
    sizes.push(len);
  }

  const blankish = sizes.filter((n) => n < 1200).length;
  const median = [...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)] ?? 0;
  console.log(
    `${name}: ${sizes.length} pages, median ${median} bytes of marks, ` +
      `${blankish} page(s) under 1200 bytes`,
  );
  sizes.forEach((n, i) => {
    if (n < 1200) console.log(`   page ${i + 1}: ${n} bytes`);
  });
}
