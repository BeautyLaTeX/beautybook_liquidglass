(() => {
  const vscode=acquireVsCodeApi(), $=id=>document.getElementById(id);
  globalThis.bindLiquidGlassFontScale(vscode);
  const meter=globalThis.mountLiquidGlassMeter();
  const engineNames={pdflatex:'pdfLaTeX',xelatex:'XeLaTeX',lualatex:'LuaLaTeX'};
  const folderNames={source:'编辑文件',root:'工作区',main:'主文件',temporary:'临时构建目录',pdf:'PDF',synctex:'SyncTeX',log:'失败日志'};
  let latest, timer, toastTimer, stagesKey;
  const send=(action,data={})=>vscode.postMessage({action,...data});
  const text=(id,value)=>{ $(id).textContent=value; };
  const time=ms=>{
    const sec=Math.max(0,Math.floor(ms/1000));
    return sec>=60?Math.floor(sec/60)+'分 '+sec%60+'秒':sec+'秒';
  };
  const selection=()=>send('select',{
    engine:document.querySelector('[name=engine]:checked').value,
    shellEscape:$('shell').checked,followProject:$('follow').checked
  });
  for(const action of ['studio','build','cancel','pdf','output'])$(action).addEventListener('click',()=>send(action));
  for(const id of ['engines','shell','follow'])$(id).addEventListener('change',selection);
  function elapsed(){
    text('elapsed',latest?.started?time((latest.ended??Date.now())-latest.started):'');
  }
  function list(steps) {
    const key = JSON.stringify(steps);
    if (key===stagesKey) return;
    stagesKey = key;
    $('steps').replaceChildren(...steps.map(stage=>{
      const item=document.createElement('li');item.dataset.status=stage.state;
      const point=document.createElement('i');point.setAttribute('aria-hidden','true');
      const title=document.createElement('span');title.textContent=stage.label;
      if(stage.state==='current')item.setAttribute('aria-current','step');
      if(stage.state==='failed')item.setAttribute('aria-label',stage.label+'失败');
      if(stage.state==='stopped')item.setAttribute('aria-label',stage.label+'停止');
      const orbit=document.createElement('span');
      orbit.className='step-orbit';
      orbit.setAttribute('aria-hidden','true');
      item.append(point,title,orbit);
      return item;
    }));
  }
  function history(state) {
    $('history').hidden=state.timeline.length<2;
    $('history-list').replaceChildren(...state.timeline.map(event=>{
      const row=document.createElement('li'), mark=document.createElement('time');
      mark.textContent=time(event.time-state.started);
      row.append(mark,document.createTextNode(event.title+(event.attempt>1?' · 第 '+event.attempt+' 次':'')));
      return row;
    }));
  }
  function paths(state) {
    const choices=Object.entries(folderNames).filter(([key])=>state.paths[key]&&
      (key!=='log'||state.phase==='error'));
    $('paths').hidden=!choices.length;
    $('path-list').replaceChildren(...choices.flatMap(([key,label])=>{
      const name=document.createElement('dt'), item=document.createElement('dd'), button=document.createElement('button');
      name.textContent=label;
      button.textContent=state.paths[key];
      button.title=state.paths[key]+' · 点击复制';
      button.addEventListener('click',()=>send('copyPath',{key}));
      item.append(button);
      return [name,item];
    }));
  }
  function errors(records) {
    $('errors').hidden=!records.length;
    text('error-count',records.length?String(records.length):'');
    $('problems').replaceChildren(...records.map((record,index)=>{
      const row=document.createElement('li');
      const item=document.createElement(record.link?'button':'div');
      const message=document.createElement('span');
      if(record.file){
        const location=document.createElement('small');
        const name=record.file.split(/[\\/]/).at(-1);
        location.textContent=name+' · 第 '+record.line+' 行'+(record.link?' ↗':'');
        location.title=record.file;
        item.append(location);
      }
      message.textContent=record.message;
      item.append(message);
      if(record.link)item.addEventListener('click',()=>send('jump',{index}));
      row.append(item);
      return row;
    }));
  }
  window.addEventListener('message',({data})=>{
    if(data.type==='notice') {
      text('toast',data.message);$('toast').hidden=false;clearTimeout(toastTimer);
      toastTimer=setTimeout(()=>$('toast').hidden=true,2000);return;
    }
    if(!data.stages)return;
    latest=data;meter(data);elapsed();
    if(timer)clearInterval(timer);
    if(data.busy&&!data.ended)timer=setInterval(elapsed,1000);
    const file=data.file||'打开一个 .tex 文件';
    text('file',file);$('file').title=data.paths.main||data.paths.source||file;
    text('engine',engineNames[data.engine]||'');$('engine').hidden=!data.engine;
    text('phase',data.title);
    text('detail',data.detail||'');$('detail').hidden=!data.detail;
    const current=data.stages.findIndex(stage=>stage.id===data.step);
    const nextText=data.busy&&!data.ended?(data.stages[current+1]?.label??(data.step==='save'?'完成':'判断构建路径')):'';
    text('next',nextText?'下一步 · '+nextText:'');$('next').hidden=!nextText;
    text('route',data.route==='glass'?'LiquidGlass':data.route==='plain'?'普通 LaTeX':'');
    document.querySelector('.instrument').dataset.phase=data.phase;
    document.querySelector('.instrument').dataset.running=String(data.busy&&!data.ended);
    $('follow').checked=data.selection.followProject;$('follow').disabled=data.busy;
    $('engines').disabled=$('shell').disabled=data.busy||$('follow').checked;
    $('build').hidden=$('cancel').hidden=data.busy;
    $('cancel').hidden=!data.busy;$('pdf').hidden=!data.pdf;
    $('shell').checked=data.selection.shellEscape;
    document.querySelector('[name=engine][value="'+data.selection.engine+'"]').checked=true;
    list(data.stages);history(data);paths(data);errors(data.problems);
  });
  send('ready');
})();
