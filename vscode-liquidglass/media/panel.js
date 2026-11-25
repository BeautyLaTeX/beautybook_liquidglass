const vscode = acquireVsCodeApi();
const get = id => document.getElementById(id);
for (const action of ['build', 'cancel', 'pdf', 'output']) {
  get(action).addEventListener('click', () => vscode.postMessage({ action }));
}

window.addEventListener('message', ({ data }) => {
  get('file').textContent = data.file || '选择一个 .tex 文件';
  get('phase').textContent = data.title;
  get('status').dataset.phase = data.phase;
  get('status').dataset.busy = data.busy;
  get('detail').textContent = data.detail;
  get('detail').hidden = !data.detail;
  get('build').disabled = data.busy;
  get('cancel').hidden = !data.busy;
  get('pdf').hidden = !data.pdf;
  const reached = { capture: 1, render: 2, compose: 3, latex: 2, done: 3 }[data.phase] || 0;
  [...get('progress').children].forEach((step, i) => step.classList.toggle('reached', i < reached));
  get('problems').replaceChildren(...data.problems.map((entry, index) => {
    const li = document.createElement('li');
    const link = document.createElement('button');
    const location = document.createElement('small');
    link.textContent = entry.message;
    location.textContent = entry.file.split(/[\\/]/).pop() + ' · ' + entry.line;
    link.append(location);
    link.addEventListener('click', () => vscode.postMessage({ action: 'jump', index }));
    li.append(link);
    return li;
  }));
  get('errors').hidden = data.problems.length === 0;
});
vscode.postMessage({ action: 'ready' });
