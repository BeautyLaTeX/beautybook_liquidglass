const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { renderWebview, bindWebviewFontScale } = require('./webview');
const { registerStudio } = require('./selection');
const { registerMaterialLab } = require('./studio');
const { createBuildLog } = require('./build-log');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { ENGINES, captions, buildSelection, selectionArguments, initialBuild, progressFor, tick, routeStatus, diagnostics } = require('./build-ui');

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

function environment(extensionPath) {
  const defaults = process.platform === 'darwin'
    ? ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin'] : [];
  return { ...process.env, PATH: [process.env.PATH, ...defaults, process.platform === 'darwin' && extensionPath && path.join(extensionPath,'runtime','mac-bin')].filter(Boolean).join(path.delimiter), PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' };
}

async function pythonFor(root, mainDir, configured, env) {
  const pythonIn = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  const candidateFrom = dir => path.join(dir, '.venv', pythonIn);
  const externalVenv = path.join(path.dirname(root), '.' + path.basename(root) + '.venv', pythonIn);
  const candidates = configured ? [configured] : [
    env.LIQUIDGLASS_PYTHON, candidateFrom(mainDir), candidateFrom(root), externalVenv, 'python3', 'python',
    '/opt/homebrew/bin/python3', '/usr/local/bin/python3'
  ];
  let usable;
  let pillow;
  for (const candidate of new Set(candidates.filter(Boolean))) {
    try {
      const result = await childResult(spawn(candidate, ['-c',
        'import sys\ndef available(module):\n try: __import__(module)\n except (ImportError, OSError): return False\n return True\nprint(int(sys.version_info >= (3, 9)), int(available("PIL.ImageCms")), int(available("numpy")))'
      ], { env, windowsHide: true }), undefined, 5000);
      if (result.code !== 0) continue;
      const [supported, hasPillow, hasNumPy] = result.stdout.trim().split(/\s+/);
      if (supported !== '1') continue;
      if (configured || (hasPillow === '1' && hasNumPy === '1')) return candidate;
      if (hasPillow === '1') pillow ??= candidate;
      usable ??= candidate;
    } catch (error) {
      if (configured) throw error;
    }
  }
  if (pillow || usable) return pillow || usable;
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

function configuredPython(uri) {
  return vscode.workspace.getConfiguration('liquidglassLatexStudio',uri).get('python') ||
    vscode.workspace.getConfiguration('liquidglassBuild',uri).get('python');
}

async function legacySelection(context) {
  if (context.storageUri?.scheme !== 'file') return undefined;
  const database = path.join(path.dirname(context.storageUri.fsPath),'state.vscdb');
  if (!await fs.stat(database).then(stat=>stat.isFile()).catch(()=>false)) return undefined;
  const env = environment();
  const python = await pythonFor(path.dirname(database),path.dirname(database),undefined,env);
  const script = path.join(context.extensionPath,'runtime','legacy_state.py');
  const result = await childResult(spawn(python,[script,database],{env,windowsHide:true}),undefined,2500);
  if (result.code === 0) return JSON.parse(result.stdout);
}

async function activate(context) {
  const studioEnvironment = () => environment(context.extensionPath);
  const output = createBuildLog();
  const problems = vscode.languages.createDiagnosticCollection('LiquidGlass LaTeX Studio');
  let view, request, lastPdf, activeSource;
  const selectionKey = 'liquidglassLatexStudio.selection';
  const stored = context.workspaceState.get(selectionKey);
  const previous = stored === undefined ? await legacySelection(context).catch(()=>undefined) : undefined;
  let selection = buildSelection(stored ?? previous ?? {followProject:true});
  if (previous) await context.workspaceState.update(selectionKey,selection);
  let state = initialBuild();

  const publish = () => {
    const event = { ...state, selection, title:captions[state.phase], stages:routeStatus(state) };
    view?.webview.postMessage(event);
    studioSettings.buildState(event);
  };
  const update = change => { state = { ...state, ...change }; publish(); };
  const currentUri = () => vscode.window.activeTextEditor?.document.uri;
  const uriForBuild = () => {
    const uri = currentUri();
    if (uri?.scheme === 'file' && /\.tex$/i.test(uri.path)) return uri;
    return activeSource ? vscode.Uri.file(activeSource) : undefined;
  };
  const syncEditor = () => {
    const uri = currentUri();
    if (!uri || !/\.tex$/i.test(uri.path) || uri.fsPath === activeSource) return;
    activeSource = uri.fsPath;
    if (state.phase==='idle') update(initialBuild(path.basename(uri.path),{source:uri.fsPath}));
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
    const selected = uri?.fsPath ? uri : uriForBuild();
    if (!selected || selected.scheme !== 'file' || !/\.tex$/i.test(selected.fsPath)) {
      vscode.window.showInformationMessage('请打开或右键选择一个已保存的 LaTeX 文件。'); return;
    }
    const job = request = { canceled: false, child: null };
    const flags = selectionArguments(selection);
    let main = selected.fsPath;
    const root = vscode.workspace.getWorkspaceFolder(selected)?.uri.fsPath ?? path.dirname(main);
    activeSource = main;
    const now=Date.now();
    state = initialBuild(path.basename(main),{source:main,root});
    update({ ...tick(state,{phase:'inspect',progress:3},now), busy:true, started:now,
      timeline:[{step:'inspect',title:captions.inspect,time:now,attempt:1}] });
    output.clear();
    output.appendLine(captions.inspect + ' · ' + main);
    problems.clear();
    try {
      for (const doc of vscode.workspace.textDocuments) {
        if (!doc.isDirty || doc.uri.scheme !== 'file') continue;
        if (doc.uri.fsPath !== selected.fsPath && vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath !== root) continue;
        if (!(await doc.save())) throw new Error('保存失败。请保存改动后重新编译。');
      }
      const launcher = await prepareLauncher(context);
      const env = studioEnvironment();
      const python = await pythonFor(root, path.dirname(main), configuredPython(selected), env);
      if (job.canceled) return;
      const args = [launcher, root, '--inspect-json', ...flags];
      job.child = spawn(python,[...args,main],{cwd:root,env,detached:process.platform!=='win32',windowsHide:true});
      const inspected = await childResult(job.child,undefined,30000);
      job.child = undefined;
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
      const stem=path.join(path.dirname(main),'build',path.basename(main,path.extname(main)));
      const pdf=main.replace(/\.tex$/i,'.pdf');
      output.appendLine(captions.prepare + ' · ' + main);
      update({...tick(state,{phase:'prepare',route:plan.route,progress:10}),engine:plan.engine,
        paths:{source:selected.fsPath,root,main,pdf,synctex:pdf.replace(/\.pdf$/i,'.synctex.gz'),log:stem+'.log'}});
      if (plan.shell === true) {
        const answer = await vscode.window.showWarningMessage(
          '当前构建需要完整 shell-escape。TeX 可以执行文档中的外部命令。',
          { modal: true, detail: plan.reason + '\n' + main },
          '仅允许本次编译'
        );
        if (!answer || job.canceled) { job.canceled = true; return; }
      }
      const shellLabel = plan.shell === true ? '完整权限' : plan.shell === 'restricted' ? '受限权限' : '已关闭';
      const detail = path.basename(main) === state.file ? '' : '主文件 ' + path.basename(main);
      update({detail:detail||'正在启动 '+plan.engine,shellLabel});
      output.appendLine(plan.engine + '  ·  Shell escape ' + shellLabel);
      output.appendLine(main + '\n' + detail + '\n' + plan.reason + '\n');
      job.child = spawn(python, [launcher, root, '--no-open', '--no-pause', '--sync-next-to-pdf', ...['--engine',plan.engine,plan.shell === true ? '--shell-escape' : plan.shell === 'restricted' ? '--restricted-shell-escape' : '--no-shell-escape'], main],
        { cwd: path.dirname(main), env: { ...env, LIQUIDGLASS_PROGRESS: '1', max_print_line: '4096' }, detached: process.platform !== 'win32', windowsHide: true });
      const result = await childResult(job.child, line => {
        if (!line.startsWith('LiquidGlass progress: ')&&!line.startsWith('LiquidGlass stage: ')) output.appendLine(line);
        const event = progressFor(line);
        if (event && !job.canceled) {
          const next = tick(state,event);
          if (line.startsWith('LiquidGlass stage: ') &&
              (next.phase !== state.phase || next.detail !== state.detail)) {
            output.appendLine(captions[next.phase] + (next.detail ? ' · ' + next.detail : ''));
          }
          update(next);
        }
      });
      if (job.canceled) return;
      if (result.code !== 0) {
        const log = await fs.readFile(path.join(path.dirname(main), 'build', path.basename(main, '.tex') + '.log'), 'utf8').catch(() => '');
        if (log) output.appendLine('\n[TeX 日志]\n' + log);
        const physicalRoot = await fs.realpath(root).catch(() => root);
        const records = diagnostics(result.stdout + '\n' + result.stderr + '\n' + log, main).map(record => {
          const local = path.relative(physicalRoot, record.file);
          return { ...record, file: !path.isAbsolute(local) && local !== '..' && !local.startsWith('..' + path.sep)
            ? path.join(root, local) : record.file };
        });
        const fallback = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).find(line => /Build:|Error|failed/i.test(line)) || '详情见底部输出。';
        if (!records.length) records.push({ message:fallback });
        const grouped = new Map();
        for (const record of records) {
          if (!record.file || !record.line) continue;
          record.link = await fs.stat(record.file).then(stat=>stat.isFile()).catch(()=>false);
          if (!record.link) continue;
          const line = record.line - 1;
          const item = new vscode.Diagnostic(new vscode.Range(line, 0, line, 1), record.message);
          item.source = 'LiquidGlass';
          if (!grouped.has(record.file)) grouped.set(record.file, []);
          grouped.get(record.file).push(item);
        }
        problems.set([...grouped].map(([file, items]) => [vscode.Uri.file(file), items]));
        update({phase:'error',detail:'',problems:records,ended:Date.now()});
        return;
      }
      lastPdf = main.replace(/\.tex$/i, '.pdf');
      output.appendLine(captions.done + ' · ' + lastPdf);
      update({phase:'done',progress:100,detail:'',pdf:true,ended:Date.now()});
    } catch (error) {
      if (!job.canceled) {
        output.appendLine(error.message);
        update({phase:'error',problems:[{message:error.message}],ended:Date.now()});
      }
    } finally {
      request = null;
      update({ busy: false, ...(job.canceled ? { phase:'canceled',detail:'',ended:Date.now() } : {}) });
    }
  }

  async function openPdf(file) {
    const viewer = vscode.extensions.getExtension('james-yu.latex-workshop');
    if (viewer) {
      await viewer.activate();
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'latex-workshop-pdf-hook');
    } else {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
    }
  }

  const viewPdf = () => lastPdf && state.pdf && openPdf(lastPdf);
  const studioSettings = registerStudio(context,{
    output, environment:studioEnvironment, selection:() => selection, launcher:() => prepareLauncher(context), openPdf, build, cancel, viewPdf, publishBuild:publish,
    python:(root, dir, uri) => pythonFor(root,dir,configuredPython(uri),studioEnvironment())
  });

  registerMaterialLab(context,{
    environment:studioEnvironment,
    python:(root, uri) => pythonFor(root,root,configuredPython(uri),studioEnvironment())
  });
  context.subscriptions.push(output, problems, { dispose: cancel },
    vscode.commands.registerCommand('liquidglassLatexStudio.buildPanel',
      ()=>vscode.commands.executeCommand('liquidglassLatexStudio.sidebar.focus')),
    vscode.window.onDidChangeActiveTextEditor(syncEditor),
    vscode.commands.registerCommand('liquidglassLatexStudio.build', build),
    vscode.commands.registerCommand('liquidglassLatexStudio.cancel', cancel),
    vscode.commands.registerCommand('liquidglassLatexStudio.output', () => output.show()),
    vscode.commands.registerCommand('liquidglassLatexStudio.pdf', viewPdf),
    vscode.window.registerWebviewViewProvider('liquidglassLatexStudio.sidebar', {
      async resolveWebviewView(next) {
        view = next;
        const fontScale = bindWebviewFontScale(next.webview);
        next.webview.html = await renderWebview(context,next.webview,'panel',[['ICON','media/studio-icon.png'],['METER','media/meter.js']]);
        next.webview.onDidReceiveMessage(async ({ action, index, key, engine, shellEscape, followProject }) => {
          if (action === 'ready') publish();
          if (action === 'select' && !state.busy && ENGINES.includes(engine) && typeof shellEscape === 'boolean' && typeof followProject === 'boolean') {
            selection = buildSelection({ engine, shellEscape, followProject });
            publish();
            studioSettings.settings();
            await context.workspaceState.update(selectionKey, selection);
          }
          if (action === 'studio') await vscode.commands.executeCommand('liquidglassLatexStudio.studio');
          if (action === 'previewSelection') await vscode.commands.executeCommand('liquidglassLatexStudio.previewSelection');
          if (action === 'build') await build(uriForBuild());
          if (action === 'cancel') await cancel();
          if (action === 'output') await output.show();
          if (action === 'pdf') await viewPdf();
          if (action === 'copyPath' && typeof state.paths[key]==='string' && Object.hasOwn(state.paths,key)) {
            await vscode.env.clipboard.writeText(state.paths[key]);
            next.webview.postMessage({type:'notice',message:'路径已复制'});
          }
          const problem = state.problems[index];
          if (action === 'jump' && problem?.link && Number.isInteger(index)) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(problem.file)).catch(() => undefined);
            if (doc) {
              const line = Math.min(doc.lineCount - 1, problem.line - 1);
              const selected = new vscode.Range(line,0,line,doc.lineAt(line).text.length);
              const editor = await vscode.window.showTextDocument(doc,{selection:selected});
              editor.revealRange(selected,vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            }
          }
        });
        next.onDidDispose(() => {
          fontScale.dispose();
          if (view === next) view = undefined;
        });
        syncEditor();
      }
    }));
  syncEditor();
}

module.exports = { activate };
