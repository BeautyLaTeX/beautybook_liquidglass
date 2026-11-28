const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const extensionSettings = 'liquidglassLatexStudio';
const fontScaleKey = extensionSettings + '.fontScale';

function validFontScale(percent) {
  return Number.isInteger(percent) && percent >= 100 && percent <= 200;
}

function readFontScale() {
  const percent = vscode.workspace.getConfiguration(extensionSettings).get('fontScale');
  return validFontScale(percent) ? percent : 125;
}

function bindWebviewFontScale(webview) {
  const send = () => webview.postMessage({type:'fontScale',percent:readFontScale()});
  return vscode.Disposable.from(
    vscode.workspace.onDidChangeConfiguration(event=>{
      if (event.affectsConfiguration(fontScaleKey)) void send();
    }),
    webview.onDidReceiveMessage(async ({action,percent})=>{
      if (action==='getFontScale') await send();
      if (action!=='setFontScale' || !validFontScale(percent)) return;
      try {
        await vscode.workspace.getConfiguration(extensionSettings)
          .update('fontScale',percent,vscode.ConfigurationTarget.Global);
      } catch (error) {
        await send();
        void vscode.window.showErrorMessage('无法保存 LiquidGlass 字号：'+error.message);
      }
    })
  );
}

async function renderWebview(context, webview, name, assets = [], roots = []) {
  webview.options = {
    enableScripts:true,
    localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'media'),vscode.Uri.joinPath(context.extensionUri,'core'),...roots]
  };
  const html = await fs.readFile(path.join(context.extensionPath,'media',name + '.html'),'utf8');
  const uri = file => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,...file.split('/'))).toString();
  const values = {
    NONCE: randomBytes(16).toString('hex'), SOURCE:webview.cspSource,
    CSS:uri('media/' + name + '.css'), JS:uri('media/' + name + '.js'),
    FONT_CSS:uri('media/font-scale.css'), FONT_JS:uri('media/font-scale.js'), FONT_SCALE:readFontScale(),
    ...Object.fromEntries(assets.map(([key,file]) => [key,uri(file)]))
  };
  return html.replace(/\{\{(\w+)\}\}/g,(_match,key) => values[key] ?? '');
}

module.exports = { renderWebview, bindWebviewFontScale };
