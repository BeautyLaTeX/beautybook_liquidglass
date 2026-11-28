const vscode = require('vscode');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { renderWebview, bindWebviewFontScale } = require('./webview');
const source = require('./core/source');
const preview = require('./core/preview');

function registerStudio(context, services) {
  let panel, recentEditor, target, storage, job, displayed, targetId = 0, applying = false;
  let workspaceRevision = 0;
  const entries = new Map();
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const invalidate = () => { workspaceRevision++; };
  const send = message => panel?.webview.postMessage(message);
  const isTex = editor => editor?.document.uri.scheme === 'file' && /\.tex$/i.test(editor.document.fileName);
  const remember = editor => { if (isTex(editor)) recentEditor = editor; };
  const current = () => isTex(vscode.window.activeTextEditor) ? vscode.window.activeTextEditor : recentEditor;
  const range = capture => new vscode.Range(capture.document.positionAt(capture.start),capture.document.positionAt(capture.end));
  const settings = () => send({ type:'settings', engine:services.selection().engine, followProject:services.selection().followProject, trusted:vscode.workspace.isTrusted });
  const publicTarget = value => ({ type:'target', id:value.id, source:value.text, file:value.file,
    location:value.location, expanded:value.expanded, demo:!value.document, stale:false, beautybook:value.look?.beautybook, backdrop:value.look?.backdrop });

  remember(vscode.window.activeTextEditor);
  context.subscriptions.push(watcher,watcher.onDidCreate(invalidate),watcher.onDidDelete(invalidate),watcher.onDidChange(invalidate),
    vscode.workspace.onDidGrantWorkspaceTrust(settings),vscode.window.onDidChangeActiveTextEditor(remember),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.contentChanges.length) invalidate();
      if (!event.contentChanges.length || event.document !== target?.document || applying) return;
      if (target.stale) return;
      const anchor = target;
      let start = anchor.start, end = anchor.end, overlap = false, changed = false;
      for (const change of [...event.contentChanges].sort((a,b) => b.rangeOffset - a.rangeOffset)) {
        const left = change.rangeOffset, right = left + change.rangeLength;
        const shift = change.text.length - change.rangeLength;
        if (right <= start) { start += shift; end += shift; }
        else if (left >= end) continue;
        else if (left >= start && right <= end) { end += shift; changed = true; }
        else { overlap = true; break; }
      }
      if (overlap && event.document.getText(range(anchor)) === anchor.text) {
        anchor.version = event.document.version;
        return;
      }
      if (overlap || end <= start || end - start > 100000) {
        anchor.stale = true;
        send({ type:'stale' });
        return;
      }
      anchor.start = start;
      anchor.end = end;
      anchor.version = event.document.version;
      anchor.location = linesFor(event.document,start,end);
      const visible = changed ? event.document.getText(range(anchor)) : anchor.text;
      if (visible !== anchor.text) {
        const previousId = anchor.id;
        anchor.id = ++targetId;
        anchor.text = visible;
        job?.controller.abort();
        displayed = null;
        send({ ...publicTarget(anchor), type:'source-update', previousId });
      } else send({ type:'location', id:anchor.id, location:anchor.location, expanded:anchor.expanded });
    }));

  function linesFor(document, start, end) {
    const first = document.positionAt(start).line + 1;
    const endPosition = document.positionAt(end);
    const last = Math.max(first,endPosition.line + Number(endPosition.character > 0));
    return first === last ? '第 ' + first + ' 行' : first + '–' + last + ' 行';
  }

  function select(editor, force = false) {
    const doc = editor?.document;
    if (!doc || doc.isClosed || !isTex(editor)) return false;
    const selection = editor.selection;
    const scope = source.fragment(doc.getText(),doc.offsetAt(selection.start),doc.offsetAt(selection.end));
    if (!scope || scope.end - scope.start > 100000) return false;
    if (!force && !target?.stale && target?.document === doc && target.start === scope.start && target.end === scope.end) return true;
    job?.controller.abort();
    displayed = null;
    const uri = doc.uri;
    target = { id:++targetId, ...scope, document:doc, version:doc.version, text:doc.getText(new vscode.Range(doc.positionAt(scope.start),doc.positionAt(scope.end))),
      file:path.basename(doc.fileName), location:linesFor(doc,scope.start,scope.end),
      project:vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath) };
    const selected = target;
    send(publicTarget(selected));
    void projectLook(selected).then(look => {
      if (!look || target !== selected) return;
      selected.look = look;
      send({type:'project-look',id:selected.id,...look});
    }).catch(()=>{});
    return true;
  }

  function sample() {
    job?.controller.abort();
    displayed = null;
    target = { id:++targetId, text:source.sample, file:'Material study', location:'工作台样片' };
    send(publicTarget(target));
  }

  async function projectLook(capture) {
    let document = capture.document;
    let bodyEnd = capture.start;
    let text = document.getText();
    const magic = /^\s*%\s*!\s*TeX\s+root\s*=\s*(.*?)\s*$/im.exec(text);
    if (magic && !preview.preamble(text)) {
      const file = path.resolve(path.dirname(document.fileName),magic[1].replace(/^["']|["']$/g,''));
      document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      text = document.getText();
      const chapter = capture.document.fileName;
      const match = [...source.mask(text).matchAll(/\\(?:input|include|subfile)\s*\{([^{}]+)\}/g)].find(input => {
        const token = input[1].trim();
        return path.resolve(path.dirname(file),/\.tex$/i.test(token) ? token : token+'.tex') === chapter;
      });
      bodyEnd = match?.index ?? 0;
    }
    const preamble = preview.preamble(text);
    if (!/\bbeautybook-liquidglass\b/.test(source.mask(preamble))) return undefined;
    const state = preview.bodyContext(text,bodyEnd);
    const beautybook = /(?:mainmatter|BeautyGlassOn)$/.test(state);
    if (!beautybook && !source.describe(capture.text).properties.some(prop=>prop.key.startsWith('lg '))) return undefined;
    const declarations = [...source.mask(text.slice(0,Math.max(bodyEnd,preamble.length))).matchAll(/\\(?:BeautyGlassBackground|glassbackground)\s*\{([^{}]+)\}/g)];
    const name = declarations.at(-1)?.[1].trim() ?? '@silver';
    const relative = name === '@silver' ? 'liquidglass-assets/frost-silver.png' :
      name === '@default' ? 'liquidglass-assets/default.png' : name;
    const dir = await fs.realpath(path.dirname(document.fileName));
    const file = await fs.realpath(path.resolve(dir,relative)).catch(()=>null);
    if (!file || !file.startsWith(dir + path.sep) || !/\.(?:png|jpe?g|webp)$/i.test(file)) return {beautybook};
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 4*1024*1024) return {beautybook};
    const image = await fs.readFile(file);
    const ext = path.extname(file).slice(1).toLowerCase().replace('jpg','jpeg');
    return {beautybook, backdrop:'data:image/' + ext + ';base64,' + image.toString('base64')};
  }

  async function rootFor(capture, signal) {
    let doc = capture.document;
    if (!doc) return { inherited:'', dir:undefined };
    const visited = new Set();
    while (doc) {
      const file = doc.uri.fsPath;
      if (visited.has(file)) throw new Error('检测到循环的 % !TeX root 指令。');
      visited.add(file);
      const magic = /^\s*%\s*!\s*TeX\s+root\s*=\s*(.*?)\s*$/im.exec(doc.getText());
      if (!magic) break;
      const name = path.resolve(path.dirname(file),magic[1].replace(/^["']|["']$/g,''));
      if (name === file || await fs.realpath(name).catch(()=>name) === await fs.realpath(file).catch(()=>file)) break;
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(name)).catch(() => null);
      if (!doc) throw new Error('根文件不存在：' + name);
    }
    const rootContext = root => {
      const text = root.getText();
      const dir = path.dirname(root.fileName);
      let offset = root === capture.document ? capture.start : 0;
      if (!offset && root !== capture.document) {
        for (const match of source.mask(text).matchAll(/\\(?:input|include|subfile)\s*\{([^{}]+)\}/g)) {
          const relative = match[1].trim();
          const filename = path.resolve(dir,/\.tex$/i.test(relative) ? relative : relative + '.tex');
          if (filename === capture.document.fileName) { offset = match.index; break; }
        }
      }
      return { inherited:preview.preamble(text), dir, main:root.fileName, body:preview.bodyContext(text,offset) };
    };
    const own = preview.preamble(doc.getText());
    if (own) return rootContext(doc);
    const base = path.dirname(doc.fileName);
    const direct = /\\documentclass\s*\[([^\]]+)\]\s*\{subfiles\}/.exec(source.mask(doc.getText()));
    if (direct) {
      const parent = await vscode.workspace.openTextDocument(vscode.Uri.file(path.resolve(base,direct[1])));
      const inherited = preview.preamble(parent.getText());
      if (inherited) return rootContext(parent);
    }
    // Reuse the full-build resolver for saved chapters included by one or more main files.
    if (await fs.stat(capture.document.fileName).catch(() => false)) {
      const launcher = await services.launcher();
      const python = await services.python(capture.project,base,capture.document.uri);
      const result = await preview.run(python,[launcher,capture.project,'--inspect-json','--no-shell-escape',capture.document.fileName],
        { cwd:capture.project, env:services.environment(), signal, timeout:15000 });
      if (result.code !== 0) throw new Error(result.log.trim().split('\n').at(-1) || '无法查找主文件。');
      const plans = JSON.parse(result.log);
      const pick = plans.length > 1 ? await vscode.window.showQuickPick(plans.map(({main}) => ({
        label:path.basename(main),description:path.relative(capture.project,main),main
      })),{ placeHolder:'选择局部预览要继承的主文件' }) : plans[0];
      if (plans.length && !pick) throw new Error('已取消');
      if (pick) {
        const root = await vscode.workspace.openTextDocument(vscode.Uri.file(pick.main));
        return rootContext(root);
      }
    }
    return { inherited:'', dir:base };
  }

  async function findDriver(options, dirs) {
    const explicit = options.env.LIQUIDGLASS_DRIVER;
    if (explicit) {
      await fs.access(explicit);
      return path.resolve(explicit);
    }
    for (const dir of new Set(dirs.filter(Boolean))) {
      const driver = path.join(dir,'lgbuild.py');
      if (await fs.stat(driver).then(s => s.isFile()).catch(() => false)) return driver;
    }
    const installed = await preview.run('kpsewhich',['--format=texmfscripts','liquidglass/lgbuild.py'],options);
    return installed.code === 0 ? installed.log.trim() : null;
  }

  async function render(text) {
    if (!vscode.workspace.isTrusted) throw new Error('请在信任的工作区中运行 TeX。');
    if (!target || target.stale || typeof text !== 'string' || !text.trim() || text.length > 100000) return;
    const origin = target;
    if (job?.controller.signal.aborted) await job.done.catch(() => {});
    if (job || target !== origin) return;
    const capture = target, picked = services.selection();
    let engine = picked.engine;
    const revision = workspaceRevision;
    const controller = new AbortController();
    const thisJob = { controller, done:null };
    job = thisJob;
    send({ type:'native', status:'busy', id:capture.id, source:text, engine, followProject:picked.followProject });
    thisJob.done = (async () => {
      const signal = controller.signal;
      const contextInfo = await rootFor(capture,signal);
      if (signal.aborted) return;
      const base = capture.document && path.dirname(capture.document.fileName);
      if (picked.followProject && contextInfo.main && await fs.stat(contextInfo.main).catch(()=>false)) {
        const launcher = await services.launcher();
        const python = await services.python(capture.project,base,capture.document.uri);
        const result = await preview.run(python,[launcher,capture.project,'--inspect-json','--no-shell-escape',contextInfo.main],
          { cwd:capture.project, env:services.environment(), signal, timeout:15000 });
        if (result.code !== 0) throw new Error(result.log.trim().split('\n').at(-1) || '无法读取项目引擎设置。');
        engine = JSON.parse(result.log)[0]?.engine ?? engine;
        send({type:'native',status:'busy',id:capture.id,source:text,engine,followProject:true});
      }
      const key = createHash('sha256').update(JSON.stringify([engine,text,contextInfo,capture.project,base,revision])).digest('hex');
      const cached = entries.get(key);
      let entry = cached?.deps && JSON.stringify(cached.deps) === JSON.stringify(await preview.snapshot(cached.deps.map(([file]) => file))) ? cached : null;
      const cacheHit = Boolean(entry);
      if (!entry) {
        const folder = await storage;
        const env = services.environment();
        entry = await preview.compile({
          fragment:text, inherited:contextInfo.inherited, body:contextInfo.body, sourceDir:base, mainDir:contextInfo.dir,
          storage:folder, project:capture.project, extension:context.extensionPath, demo:!capture.document, engine, signal,
          env, findDriver: options => findDriver(options,[contextInfo.dir,base,capture.project]),
          python: () => services.python(capture.project ?? folder,contextInfo.dir ?? base ?? folder,capture.document?.uri)
        });
        if (signal.aborted) return;
        services.output.appendLine('\n[局部预览] ' + engine + ' · ' + capture.file + '\n' + entry.log);
      }
      entries.delete(key);
      entries.set(key,entry);
      displayed = entry;
      if (cached && cached !== entry) await fs.rm(cached.dir,{recursive:true,force:true});
      while (entries.size > 5) {
        const [oldKey,old] = entries.entries().next().value;
        entries.delete(oldKey);
        await fs.rm(old.dir,{recursive:true,force:true});
      }
      publishImage(entry,1,{ id:capture.id, source:text, engine, cacheHit, followProject:picked.followProject });
    })();
    try { await thisJob.done; }
    catch (error) {
      if (!controller.signal.aborted) {
        if (error.log) services.output.appendLine('\n[局部预览] ' + error.log);
        const count = text.split('\n').length;
        send({ type:'native', status:error.message === '已取消' ? 'canceled' : 'error',
          id:capture.id, message:error.message, line:error.line > 0 && error.line <= count ? error.line : null });
      }
    } finally {
      if (job === thisJob) job = undefined;
      if (controller.signal.aborted) send({ type:'native',status:'canceled',id:capture.id });
    }
  }

  function publishImage(entry,page,metadata) {
    if (!panel) return;
    entry.metadata = metadata;
    send({ type:'native',status:'ready', ...metadata, page, pages:entry.pages, png:entry.page &&
      panel.webview.asWebviewUri(vscode.Uri.file(entry.page)).toString() });
  }

  async function changePage(page) {
    const entry = displayed;
    if (job || !entry || !Number.isInteger(page) || page < 1 || page > entry.pages) return;
    try {
      const png = await preview.rasterize(entry.pdf,page,{ ...entry.options, signal:undefined });
      if (entry !== displayed) return;
      entry.page = png;
      publishImage(entry,page,entry.metadata);
    } catch (error) { send({ type:'notice', message:error.message }); }
  }

  async function apply(text) {
    const capture = target, trustedVersion = capture?.document?.version;
    if (!capture?.document || capture.stale || capture.version !== trustedVersion || capture.document.isClosed || capture.document.getText(range(capture)) !== capture.text) {
      send({ type:'notice', message:'编辑器中的选区已变化。请重新载入选区后应用。' });
      return;
    }
    if (typeof text !== 'string' || text.length > 100000 || !text.trim() || applying) return;
    const eol = capture.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    text = text.replace(/\r?\n/g,eol);
    if (text === capture.text) return;
    const editor = vscode.window.visibleTextEditors.find(item => item.document === capture.document) ??
      await vscode.window.showTextDocument(capture.document,{preserveFocus:true});
    if (capture !== target || capture.document.version !== trustedVersion) return;
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(text.length,capture.text.length) && text[prefix] === capture.text[prefix]) prefix++;
    while (suffix < Math.min(text.length,capture.text.length) - prefix &&
      text[text.length - 1 - suffix] === capture.text[capture.text.length - 1 - suffix]) suffix++;
    applying = true;
    let ok;
    try {
      ok = await editor.edit(edit => edit.replace(new vscode.Range(capture.document.positionAt(capture.start + prefix),
        capture.document.positionAt(capture.end - suffix)),text.slice(prefix,text.length - suffix)));
    } finally { applying = false; }
    if (capture !== target) return;
    if (!ok) { send({ type:'notice',message:'应用失败，请重新载入选区。' }); return; }
    capture.end = capture.start + text.length;
    capture.text = text;
    capture.version = capture.document.version;
    capture.location = linesFor(capture.document,capture.start,capture.end);
    send({ type:'location', id:capture.id, location:capture.location, expanded:capture.expanded });
    send({ type:'applied', source:text, id:capture.id });
  }

  async function open(mode) {
    const editor = current();
    if (!panel) {
      const currentStorage = fs.mkdtemp(path.join(os.tmpdir(),'liquidglass-studio-'));
      const temp = await currentStorage;
      if (panel) {
        await fs.rm(temp,{recursive:true,force:true});
        return open(mode);
      }
      storage = Promise.resolve(temp);
      const view = panel = vscode.window.createWebviewPanel('liquidglassLatexStudio.studio','LaTeX 选区预览',
        { viewColumn:vscode.ViewColumn.Beside,preserveFocus:true },{ enableScripts:true, retainContextWhenHidden:true });
      const fontScale = bindWebviewFontScale(view.webview);
      view.iconPath = vscode.Uri.joinPath(context.extensionUri,'media','studio-icon.png');
      const listener = view.webview.onDidReceiveMessage(async message => {
        try {
          if (message.action === 'ready') {
            if (target) send(publicTarget(target));
            settings();
            services.publishBuild();
            if (mode === 'native' && target?.document) await render(target.text);
            return;
          }
          if (message.action === 'load') {
            if (!select(current(),true)) send({ type:'notice',message:'请选择 LaTeX 代码，或将光标放在完整环境中。' });
            return;
          }
          if (message.action === 'sample') { sample(); return; }
          if (message.action === 'output') { await services.output.show(); return; }
          if (message.action === 'cancelBuild') { await services.cancel(); return; }
          if (message.id !== target?.id) return;
          if (message.action === 'render') await render(message.source);
          if (message.action === 'build' && target.document) {
            if (message.dirty) {
              send({type:'notice',message:'请先应用或重置草稿，再编译整篇。'});
            } else await services.build(target.document.uri);
          }
          if (message.action === 'buildPdf') await services.viewPdf();
          if (message.action === 'cancel') job?.controller.abort();
          if (message.action === 'page') await changePage(message.page);
          if (message.action === 'apply') await apply(message.source);
          if (message.action === 'copy' && typeof message.source === 'string' && message.source.length <= 100000) {
            await vscode.env.clipboard.writeText(message.source);
            send({ type:'notice', message:'已复制 LaTeX 源码' });
          }
          if (message.action === 'pdf' && displayed) await services.openPdf(displayed.pdf);
          if (message.action === 'reveal' && target.document && !target.stale) await vscode.window.showTextDocument(target.document,{selection:range(target)});
        } catch (error) { send({ type:'notice',message:error.message }); }
      });
      view.onDidDispose(() => {
        fontScale.dispose();
        listener.dispose();
        const pending = job;
        pending?.controller.abort();
        panel = target = job = displayed = storage = undefined;
        entries.clear();
        void Promise.resolve(pending?.done).catch(() => {}).then(() => fs.rm(temp,{recursive:true,force:true})).catch(() => {});
      });
      if (!select(editor)) sample();
      view.webview.html = await renderWebview(context,view.webview,'studio',[
        ['SOURCEJS','core/source.js'],['OPTICS','media/optics.js'],['SCENE','media/lab-scene.png'],['ICON','media/studio-icon.png']
      ],[vscode.Uri.file(temp)]);
      return;
    }
    panel.reveal(undefined,true);
    if (mode === 'native') {
      if (select(editor,true)) await render(target.text);
      else send({ type:'notice', message:'请选择 LaTeX 代码，或将光标放在完整环境中。' });
    }
  }

  context.subscriptions.push(
    { dispose:() => panel?.dispose() },
    vscode.commands.registerCommand('liquidglassLatexStudio.previewSelection',() => {
      const editor = current();
      if (!isTex(editor) || !source.fragment(editor.document.getText(),editor.document.offsetAt(editor.selection.start),editor.document.offsetAt(editor.selection.end))) {
        return vscode.window.showInformationMessage('请选择 LaTeX 代码，或将光标放在完整环境中。');
      }
      return open('native');
    })
  );
  return { settings, buildState:state => send({type:'build-state',state}) };
}

module.exports = { registerStudio };
