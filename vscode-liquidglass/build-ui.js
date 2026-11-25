const path = require('node:path');

const ENGINES = ['pdflatex', 'xelatex', 'lualatex'];

function buildSelection(value) {
  return {
    engine: ENGINES.includes(value?.engine) ? value.engine : 'xelatex',
    shellEscape: value?.shellEscape === true
  };
}

function selectionArguments(selection) {
  const { engine, shellEscape } = buildSelection(selection);
  return ['--engine', engine, shellEscape ? '--shell-escape' : '--no-shell-escape'];
}

function progressFor(line) {
  if (/^LiquidGlass .*: capturing /i.test(line)) return { phase: 'capture', progress: 12 };
  if (/^Layout changed .*recapturing positions/i.test(line)) return { phase: 'recapture', progress: 12 };
  const pass = /^LiquidGlass progress: capture (\d+)$/i.exec(line);
  if (pass) return { progress: Math.min(42, 12 + Number(pass[1]) * 5) };
  if (/^Rendering \d+ pane/i.test(line)) return { phase: 'render', progress: 46 };
  const panes = /^LiquidGlass progress: render (\d+)\/(\d+)$/i.exec(line);
  if (panes && Number(panes[2]) > 0) {
    return { phase: 'render', progress: Math.min(82, 46 + Math.round(36 * Number(panes[1]) / Number(panes[2]))) };
  }
  if (/^Composing final PDF/i.test(line)) return { phase: 'compose', progress: 88 };
  if (/^Running latexmk/i.test(line)) return { phase: 'latex', progress: 26 };
  if (/^Saving PDF and SyncTeX/i.test(line)) return { phase: 'save', progress: 96 };
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

module.exports = { ENGINES, buildSelection, selectionArguments, progressFor, diagnostics };
