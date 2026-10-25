const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dir = path.resolve(__dirname, '../../dist/windows');
(async () => {
  const lines = [];
  for (const file of fs.readdirSync(dir).filter((f) => /^Oneiropolos-.*\.(exe|zip)$/.test(f)).sort()) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(path.join(dir, file))) hash.update(chunk);
    lines.push(`${hash.digest('hex')}  ${file}`);
  }
  if (!lines.length) throw new Error('No Windows release artifacts found');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
})().catch((error) => { console.error(error); process.exitCode = 1; });
