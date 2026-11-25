const path = require('node:path');

function phaseFor(line) {
  if (/capturing|位置重新|recapturing/i.test(line)) return 'capture';
  if (/^Rendering \d+ pane/i.test(line)) return 'render';
  if (/^Composing final PDF/i.test(line)) return 'compose';
  if (/^Running latexmk/i.test(line)) return 'latex';
  return null;
}

function diagnostics(log, main) {
  const records = [];
  const seen = new Set();
  for (const line of log.split(/\r?\n/)) {
    const entry = /^(.*?\.(?:tex|sty|cls|bib|bbl)):(\d+):\s*(.+)$/i.exec(line.trim());
    if (!entry || /warning|rerun|==> Fatal error occurred/i.test(entry[3])) continue;
    const file = path.resolve(path.dirname(main), entry[1]);
    const lineno = Math.max(1, Number(entry[2]));
    const message = entry[3].trim();
    const id = JSON.stringify([file, lineno, message]);
    if (seen.has(id)) continue;
    seen.add(id);
    records.push({ file, line: lineno, message });
    if (records.length === 20) break;
  }
  return records;
}

module.exports = { phaseFor, diagnostics };
