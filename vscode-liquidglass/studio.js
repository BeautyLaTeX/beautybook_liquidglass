const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Material = require('./core/material');
const { compile, rasterize, run } = require('./core/preview');
const { proofDocument, proofPage } = require('./core/material-proof');
const { renderWebview, bindWebviewFontScale } = require('./webview');

const workspaceKey = 'liquidglassLatexStudio.material';
const rasterTypes = { '.png':'png','.jpg':'jpeg','.jpeg':'jpeg','.webp':'webp','.gif':'gif' };
const extensions = [...Object.keys(rasterTypes),'.pdf'];
const natural = new Intl.Collator('en',{ numeric:true,sensitivity:'base' });

function registerMaterialLab(context, services) {
  let panel, request, proofRequest;
  const send = message => panel?.webview.postMessage(message);
  const baseFolder = () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const root = uri && vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    return root || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      (uri?.scheme==='file' ? path.dirname(uri.fsPath) : undefined);
  };

  async function imagePath(image,root) {
    if (image.mode === 'file') return path.resolve(root,image.path);
    if (image.mode === 'list') return path.resolve(root,image.path.split(';').map(entry=>entry.trim()).find(Boolean) || '');
    const dir = path.resolve(root,image.path);
    const images = (await fs.readdir(dir,{withFileTypes:true})).filter(entry=>
      (entry.isFile()||entry.isSymbolicLink())&&extensions.includes(path.extname(entry.name).toLowerCase()));
    if (!images.length) throw new Error('该文件夹没有可预览的图像。');
    return path.join(dir,images.sort((a,b)=>natural.compare(a.name,b.name))[0].name);
  }

  async function localImage(image, root) {
    const file = await imagePath(image,root);
    const ext = path.extname(file).toLowerCase();
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size>32*1024*1024 || !extensions.includes(ext)) {
      throw new Error('请选择 32 MB 以内的 PNG、JPG、WebP、GIF 或 PDF 底图。');
    }
    return {file,ext};
  }

  async function readImage(image,id) {
    request?.abort();
    if (!['file','folder','list'].includes(image?.mode) || !image.path) return;
    const command = request = new AbortController();
    const root = baseFolder() || os.homedir();
    let temp;
    try {
      const {file:source,ext} = await localImage(image,root);
      let file = source;
      let format = rasterTypes[ext];
      if (ext==='.pdf') {
        temp = await fs.mkdtemp(path.join(os.tmpdir(),'lg-material-image-'));
        const result = await run('pdftoppm',['-f','1','-l','1','-singlefile','-scale-to','960','-png',file,path.join(temp,'preview')],
          { cwd:temp,env:services.environment(),signal:command.signal,timeout:12000 });
        if(result.code!==0)throw new Error('PDF 首页读取失败。');
        file = path.join(temp,'preview.png');
        format = 'png';
      }
      const content = await fs.readFile(file);
      if (!command.signal.aborted) send({ type:'image',id,url:'data:image/'+format+';base64,'+content.toString('base64') });
    } catch (err) {
      if (!command.signal.aborted) send({type:'image',id,error:err.message});
    } finally {
      if (temp) await fs.rm(temp,{recursive:true,force:true});
      if (request===command) request=undefined;
    }
  }

  async function renderProof(view, message) {
    proofRequest?.abort();
    const task = proofRequest = new AbortController();
    const reply = payload => {
      if (!task.signal.aborted && panel===view) return view.webview.postMessage({type:'proof',id:message.id,...payload});
    };
    let storage;
    try {
      if (!vscode.workspace.isTrusted) throw new Error('工作区受信任后可生成 PDF 样片。');
      const input = Material.settings(message.input);
      const root = baseFolder() || context.extensionPath;
      const uri = vscode.window.activeTextEditor?.document.uri || vscode.workspace.workspaceFolders?.[0]?.uri;
      storage = await fs.mkdtemp(path.join(os.tmpdir(),'lg-material-proof-'));
      if (['file','folder','list'].includes(input.image.mode)) {
        if (!input.image.path) throw new Error('请先选择样片底图。');
        const {file,ext} = await localImage(input.image,root);
        const name = 'sample-backdrop' + ext;
        await fs.copyFile(file,path.join(storage,name));
        input.image = {mode:'file',path:name};
      }
      const result = await compile({
        fragment:proofDocument(input,message.stage,message.part),
        extension:context.extensionPath, storage, assetRoot:storage, demo:true, dpi:200,
        engine:'xelatex', signal:task.signal, env:services.environment(), python:()=>services.python(root,uri)
      });
      const page = proofPage(message.part,result.pages);
      const image = page===1 ? result.page : await rasterize(result.pdf,page,result.options);
      if (!image) throw new Error('PDF 已生成，但系统缺少可用的 PDF 页面预览工具。');
      const imageData = await fs.readFile(image);
      const version = /LiquidGlass (\d+\.\d+\.\d+):/.exec(result.log)?.[1];
      await reply({url:'data:image/png;base64,'+imageData.toString('base64'),page,pages:result.pages,version});
    } catch (error) {
      await reply({error:error.message});
    } finally {
      if (storage) await fs.rm(storage,{recursive:true,force:true});
      if (proofRequest===task) proofRequest=undefined;
    }
  }

  async function chooseImage(mode) {
    const root = baseFolder();
    const answer = await vscode.window.showOpenDialog({
      defaultUri:root&&vscode.Uri.file(root),canSelectFiles:mode!=='folder',canSelectFolders:mode==='folder',
      canSelectMany:mode==='list',openLabel:'使用底图',
      ...(mode==='folder'?{}:{filters:{底图:extensions.map(x=>x.slice(1))}})
    });
    if (!answer?.length) return;
    const paths = answer.map(item=>(root?path.relative(root,item.fsPath):item.fsPath).split(path.sep).join('/'));
    const value = paths.join(';');
    if (!Material.imageToken({mode,path:value})) throw new Error('路径包含 TeX 样式语法无法直接使用的字符。');
    send({ type:'picked',image:{mode,path:value} });
  }

  async function open() {
    if (panel) { panel.reveal(undefined,false); return; }
    const view = panel = vscode.window.createWebviewPanel('liquidglassLatexStudio.material','LiquidGlass · 材质实验室',
      vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});
    const fontScale = bindWebviewFontScale(view.webview);
    view.iconPath = vscode.Uri.joinPath(context.extensionUri,'media','studio-icon.png');
    const listener = view.webview.onDidReceiveMessage(async message=>{
      try {
        if (message.action==='ready') send({type:'settings',input:context.workspaceState.get(workspaceKey)});
        if (message.action==='save') await context.workspaceState.update(workspaceKey,Material.settings(message.input));
        if (message.action==='copy') {
          const result={type:'copyResult',id:message.id,ok:false};
          try {
            const style=Material.style(message.input,message.mode,message.name);
            await vscode.env.clipboard.writeText(style);
            result.ok=(await vscode.env.clipboard.readText())===style;
          } catch {
            // The editor clipboard can be unavailable when the window loses focus.
          }
          await view.webview.postMessage(result);
        }
        if (message.action==='readImage') await readImage(Material.settings({image:message.image}).image,message.id);
        if (message.action==='chooseImage' && ['file','folder','list'].includes(message.mode)) await chooseImage(message.mode);
        if (message.action==='proof' && Number.isSafeInteger(message.id)) await renderProof(view,message);
        if (message.action==='cancelProof') proofRequest?.abort();
        if (message.action==='buildPanel') await vscode.commands.executeCommand('liquidglassLatexStudio.buildPanel');
      } catch (err) { send({type:'notice',message:err.message}); }
    });
    view.onDidDispose(() => {
      fontScale.dispose();
      listener.dispose();
      request?.abort();
      proofRequest?.abort();
      if (panel===view)panel=undefined;
    });
    const assets = vscode.Uri.joinPath(context.extensionUri,'runtime','glass','liquidglass-assets');
    view.webview.html = await renderWebview(context,view.webview,'material',[
      ['MODEL','core/material.js'],['CANVAS','media/material-canvas.js'],['SCENE','media/material-scene.png'],
      ['SILVER','runtime/glass/liquidglass-assets/frost-silver.png'],['FROST','runtime/glass/liquidglass-assets/frost-chroma.png'],['DEFAULT','runtime/glass/liquidglass-assets/default.png'],
      ['ICON','media/studio-icon.png']
    ],[assets]);
  }

  context.subscriptions.push(vscode.commands.registerCommand('liquidglassLatexStudio.studio',open),{dispose:()=>panel?.dispose()});
}

module.exports={registerMaterialLab};
