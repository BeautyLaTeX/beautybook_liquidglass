const vscode = require('vscode');

const scheme = 'liquidglass-build-log';
const uri = vscode.Uri.from({scheme,path:'/LiquidGlass 编译日志.log'});
const limit = 512 * 1024;

function createBuildLog() {
  const channel = vscode.window.createOutputChannel('LiquidGlass LaTeX Studio');
  const changes = new vscode.EventEmitter();
  let content = '', trimmed = false, refresh;
  const provider = vscode.workspace.registerTextDocumentContentProvider(scheme,{
    onDidChange:changes.event,
    provideTextDocumentContent:() => {
      if (!content) return 'LiquidGlass 编译日志\n\n开始编译后，日志会在此实时更新。\n';
      return (trimmed ? '[较早的日志已折叠，完整输出可在「输出」面板查看。]\n\n' : '') + content;
    }
  });

  function notify() {
    if (refresh) return;
    refresh = setTimeout(()=>{
      refresh = undefined;
      changes.fire(uri);
    },90);
  }

  return {
    appendLine(line) {
      channel.appendLine(line);
      content += line + '\n';
      if (content.length > limit) {
        const start = content.length - limit;
        const newline = content.indexOf('\n',start);
        content = content.slice(newline >= 0 && newline < content.length - 1 ? newline + 1 : start);
        trimmed = true;
      }
      notify();
    },
    clear() {
      channel.clear();
      content = '';
      trimmed = false;
      notify();
    },
    async show() {
      try {
        const visible = vscode.window.visibleTextEditors.find(editor=>editor.document.uri.toString() === uri.toString());
        const document = visible?.document ?? await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document,{viewColumn:visible?.viewColumn ?? vscode.ViewColumn.Active,
          preview:false,preserveFocus:false});
      } catch {
        channel.show(false);
      }
    },
    dispose() {
      clearTimeout(refresh);
      provider.dispose();
      changes.dispose();
      channel.dispose();
    }
  };
}

module.exports={createBuildLog};
