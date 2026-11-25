const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { phaseFor, diagnostics } = require('./build-ui');

const phases = {
  idle: '等待编译', inspect: '检测主文件与编译权限', capture: '定位跨页玻璃片段',
  render: '生成材质', compose: '合成最终 PDF', latex: '编译普通 LaTeX',
  done: '编译完成', error: '编译失败', canceled: '已取消'
};

function childResult(child, onLine = () => {}, timeout = 0) {
  let stdout = '', stderr = '';
  const output = (stream, remember) => {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    function append(text) {
      remember(text);
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) onLine(line);
    }
    stream.on('data', bytes => append(decoder.write(bytes)));
    stream.on('end', () => { append(decoder.end()); if (pending) onLine(pending); });
  };
  output(child.stdout, text => { stdout = (stdout + text).slice(-262144); });
  output(child.stderr, text => { stderr = (stderr + text).slice(-262144); });
  return new Promise((resolve, reject) => {
    const timer = timeout ? setTimeout(() => child.kill(), timeout) : null;
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function environment() {
  const defaults = process.platform === 'darwin'
    ? ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin'] : [];
  return { ...process.env, PATH: [process.env.PATH, ...defaults].filter(Boolean).join(path.delimiter), PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' };
}

async function pythonFor(root, mainDir, configured, env) {
  const candidateFrom = dir => path.join(dir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const candidates = configured ? [configured] : [
    env.LIQUIDGLASS_PYTHON, candidateFrom(mainDir), candidateFrom(root), 'python3', 'python',
    '/opt/homebrew/bin/python3', '/usr/local/bin/python3'
  ];
  let usable;
  for (const candidate of new Set(candidates.filter(Boolean))) {
    try {
      const result = await childResult(spawn(candidate, ['-c',
        'import sys, importlib.util; print(int(sys.version_info >= (3, 9)), int(importlib.util.find_spec("PIL") is not None))'
      ], { env, windowsHide: true }), undefined, 5000);
      if (result.code === 0 && result.stdout.trim() === '1 1') return candidate;
      if (result.code === 0 && result.stdout.trim() === '1 0') usable ??= candidate;
    } catch (error) {
      if (configured) throw error;
    }
  }
  if (usable) return usable;
  throw new Error('找不到 Python 3.9 或更高版本。请在设置中指定 Python。');
}

async function prepareLauncher(context) {
  const packaged = path.join(context.extensionPath, 'runtime', 'launcher.py');
  try { await fs.access(packaged); return packaged; } catch {}
  const source = await fs.readFile(path.join(context.extensionPath, '..', 'build.command'), 'utf8');
  const extracted = /^# BEGIN PYTHON\r?\n([\s\S]+?)^# END PYTHON/m.exec(source);
  if (!extracted) throw new Error('无法读取 LiquidGlass 编译入口。');
  await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
  const target = path.join(context.globalStorageUri.fsPath, 'launcher.py');
  await fs.writeFile(target, extracted[1]);
  return target;
}

function activate(context) {
  const output = vscode.window.createOutputChannel('LiquidGlass');
  const problems = vscode.languages.createDiagnosticCollection('LiquidGlass');
  let view, request, lastPdf;
  let state = { phase: 'idle', file: '', detail: '', problems: [], pdf: false, busy: false };

  const publish = () => view?.webview.postMessage({ ...state, title: phases[state.phase] });
  const update = change => { state = { ...state, ...change }; publish(); };
  const currentUri = () => vscode.window.activeTextEditor?.document.uri;
  const syncEditor = () => {
    if (state.busy) return;
    const uri = currentUri();
    update({ file: uri && /\.tex$/i.test(uri.path) ? path.basename(uri.path) : '' });
  };

  async function cancel() {
    const job = request;
    if (!job || job.canceled) return;
    job.canceled = true;
    if (job.child?.pid) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => job.child.kill());
      } else {
        try { process.kill(-job.child.pid, 'SIGINT'); } catch (error) {
          if (error.code !== 'ESRCH') output.appendLine(error.message);
        }
      }
    }
    update({ detail: '正在停止编译…' });
  }

  async function build(uri) {
    if (request) { vscode.window.showInformationMessage('已有 LiquidGlass 编译正在进行。'); return; }
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('请在信任的工作区中运行 LaTeX 编译。'); return;
    }
    const selected = uri?.fsPath ? uri : currentUri();
    if (!selected || selected.scheme !== 'file' || !/\.tex$/i.test(selected.fsPath)) {
      vscode.window.showInformationMessage('请打开或右键选择一个已保存的 LaTeX 文件。'); return;
    }
    const job = request = { canceled: false, child: null };
    let main = selected.fsPath;
    const root = vscode.workspace.getWorkspaceFolder(selected)?.uri.fsPath ?? path.dirname(main);
    const config = vscode.workspace.getConfiguration('liquidglassBuild', selected);
    update({ phase: 'inspect', file: path.basename(main), detail: '', busy: true, problems: [], pdf: false });
    output.clear();
    problems.clear();
    try {
      for (const doc of vscode.workspace.textDocuments) {
        if (!doc.isDirty || doc.uri.scheme !== 'file') continue;
        if (doc.uri.fsPath !== selected.fsPath && vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath !== root) continue;
        if (!(await doc.save())) throw new Error('保存失败。请保存改动后重新编译。');
      }
      const launcher = await prepareLauncher(context);
      const env = environment();
      const python = await pythonFor(root, path.dirname(main), config.get('python'), env);
      if (job.canceled) return;
      const choice = config.get('shellEscape', 'auto');
      const override = { off: '--no-shell-escape', restricted: '--restricted-shell-escape', full: '--shell-escape' }[choice];
      const args = [launcher, root, '--inspect-json', '--detect-shell-escape'];
      if (override) args.push(override);
      const inspected = await childResult(spawn(python, [...args, main], { cwd: root, env, windowsHide: true }), undefined, 30000);
      if (job.canceled) return;
      if (inspected.code !== 0) throw new Error(inspected.stderr.trim() || '无法解析 LaTeX 主文件。');
      const plans = JSON.parse(inspected.stdout);
      if (!plans.length) throw new Error('找不到包含当前文件的主文档。请添加 % !TeX root = 主文件.tex。');
      let plan = plans[0];
      if (plans.length > 1) {
        const pick = await vscode.window.showQuickPick(plans.map(entry => ({ label: path.basename(entry.main), description: path.relative(root, entry.main), entry })),
          { placeHolder: '选择本次编译使用的主文件' });
        if (!pick || job.canceled) { job.canceled = true; return; }
        plan = pick.entry;
      }
      main = plan.main;
      if (plan.shell === true) {
        const answer = await vscode.window.showWarningMessage(
          '当前构建需要完整 shell-escape。TeX 可以执行文档中的外部命令。',
          { modal: true, detail: plan.reason + '\n' + main },
          '仅允许本次编译'
        );
        if (!answer || job.canceled) { job.canceled = true; return; }
      }
      const shellLabel = plan.shell === true ? '完整权限' : plan.shell === 'restricted' ? '受限权限' : '已关闭';
      const flag = plan.shell === true ? '--shell-escape' : plan.shell === 'restricted' ? '--restricted-shell-escape' : '--no-shell-escape';
      const detail = plan.engine + '  ·  Shell escape ' + shellLabel;
      update({ file: path.basename(main), detail });
      output.appendLine(main + '\n' + detail + '\n' + plan.reason + '\n');
      output.show(true);
      job.child = spawn(python, [launcher, root, '--no-open', '--no-pause', '--sync-next-to-pdf', '--engine', plan.engine, flag, main],
        { cwd: path.dirname(main), env, detached: process.platform !== 'win32', windowsHide: true });
      const result = await childResult(job.child, line => {
        output.appendLine(line);
        const phase = phaseFor(line);
        if (phase && !job.canceled) update({ phase });
      });
      if (job.canceled) return;
      if (result.code !== 0) {
        const log = await fs.readFile(path.join(path.dirname(main), 'build', path.basename(main, '.tex') + '.log'), 'utf8').catch(() => '');
        const physicalRoot = await fs.realpath(root).catch(() => root);
        const records = diagnostics(result.stdout + '\n' + result.stderr + '\n' + log, main).map(record => {
          const local = path.relative(physicalRoot, record.file);
          return { ...record, file: !path.isAbsolute(local) && local !== '..' && !local.startsWith('..' + path.sep)
            ? path.join(root, local) : record.file };
        });
        const fallback = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).find(line => /Build:|Error|failed/i.test(line)) || '详情见底部输出。';
        if (!records.length) records.push({ file: main, line: 1, message: fallback });
        const grouped = new Map();
        for (const record of records) {
          const line = record.line - 1;
          const item = new vscode.Diagnostic(new vscode.Range(line, 0, line, 1), record.message);
          item.source = 'LiquidGlass';
          if (!grouped.has(record.file)) grouped.set(record.file, []);
          grouped.get(record.file).push(item);
        }
        problems.set([...grouped].map(([file, items]) => [vscode.Uri.file(file), items]));
        update({ phase: 'error', detail, problems: records });
        output.show(true);
        return;
      }
      lastPdf = main.replace(/\.tex$/i, '.pdf');
      update({ phase: 'done', detail, pdf: true });
    } catch (error) {
      if (!job.canceled) {
        output.appendLine(error.message);
        output.show(true);
        update({ phase: 'error', problems: [{ file: main, line: 1, message: error.message }] });
      }
    } finally {
      request = null;
      update({ busy: false, ...(job.canceled ? { phase: 'canceled', detail: '' } : {}) });
    }
  }

  async function viewPdf() {
    if (!lastPdf || !state.pdf) return;
    const viewer = vscode.extensions.getExtension('james-yu.latex-workshop');
    if (viewer) {
      await viewer.activate();
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(lastPdf), 'latex-workshop-pdf-hook');
    } else {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(lastPdf));
    }
  }

  context.subscriptions.push(output, problems, { dispose: cancel },
    vscode.window.onDidChangeActiveTextEditor(syncEditor),
    vscode.commands.registerCommand('liquidglassBuild.build', build),
    vscode.commands.registerCommand('liquidglassBuild.cancel', cancel),
    vscode.commands.registerCommand('liquidglassBuild.output', () => output.show(true)),
    vscode.commands.registerCommand('liquidglassBuild.pdf', viewPdf),
    vscode.window.registerWebviewViewProvider('liquidglassBuild.sidebar', {
      async resolveWebviewView(next) {
        view = next;
        const media = vscode.Uri.joinPath(context.extensionUri, 'media');
        next.webview.options = { enableScripts: true, localResourceRoots: [media] };
        const nonce = randomBytes(16).toString('hex');
        const html = await fs.readFile(path.join(context.extensionPath, 'media', 'panel.html'), 'utf8');
        next.webview.html = html.replaceAll('{{NONCE}}', nonce).replaceAll('{{SOURCE}}', next.webview.cspSource)
          .replace('{{CSS}}', next.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css')).toString())
          .replace('{{JS}}', next.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString());
        next.webview.onDidReceiveMessage(async ({ action, index }) => {
          if (action === 'ready') publish();
          if (action === 'build') await build();
          if (action === 'cancel') await cancel();
          if (action === 'output') output.show(true);
          if (action === 'pdf') await viewPdf();
          const problem = state.problems[index];
          if (action === 'jump' && problem && Number.isInteger(index)) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(problem.file)).catch(() => undefined);
            if (doc) {
              const line = Math.min(doc.lineCount - 1, problem.line - 1);
              await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
            }
          }
        });
        next.onDidDispose(() => { if (view === next) view = undefined; });
        syncEditor();
      }
    }));
  syncEditor();
}

module.exports = { activate };
