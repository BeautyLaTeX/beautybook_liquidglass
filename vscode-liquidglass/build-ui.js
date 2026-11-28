const path = require('node:path');

const ENGINES = ['pdflatex','xelatex','lualatex'];
const captions = {
  idle:'等待编译',inspect:'解析主文件',prepare:'准备 TeX',
  capture:'采集玻璃位置',recapture:'重新采集几何',render:'渲染玻璃材质',compose:'合成 PDF',
  latex:'运行 LaTeX',save:'发布 PDF 与 SyncTeX',done:'编译完成',error:'编译失败',canceled:'已停止'
};
const routes = {
  pending:['inspect','prepare'],
  plain:['inspect','prepare','latex','save'],
  glass:['inspect','prepare','capture','render','compose','save']
};
const quotas={inspect:3,prepare:10,latex:28,capture:16,recapture:16,render:47,compose:87,save:96};

function buildSelection(value) {
  return {
    engine:ENGINES.includes(value?.engine)?value.engine:'xelatex',
    shellEscape:value?.shellEscape===true,followProject:value?.followProject===true
  };
}
function selectionArguments(selection) {
  const {engine,shellEscape,followProject}=buildSelection(selection);
  return followProject?['--engine','auto']:['--engine',engine,shellEscape?'--shell-escape':'--no-shell-escape'];
}

function progressFor(line) {
  if(line.startsWith('LiquidGlass stage: ')){
    try {
      const raw=JSON.parse(line.slice('LiquidGlass stage: '.length));
      if(raw.phase==='auxiliary')return {phase:'capture',tool:raw.tool,passNumber:raw.passNumber,attempt:raw.attempt};
      if(Object.hasOwn(quotas,raw.phase)) return {
        phase:raw.phase,progress:quotas[raw.phase],route:raw.route,
        tool:raw.tool,passNumber:raw.passNumber,total:raw.total,attempt:raw.attempt,workspace:raw.workspace
      };
    }catch { return null; }
  }
  if(/^LiquidGlass .*: capturing /i.test(line))return {phase:'capture',progress:16,route:'glass'};
  if(/^Layout changed .*recapturing positions/i.test(line))return {phase:'recapture',progress:16,recapture:true};
  const pass=/^LiquidGlass progress: capture (\d+)$/i.exec(line);
  if(pass)return {phase:'capture',passNumber:+pass[1],progress:Math.min(42,16+ +pass[1]*5)};
  const render=/^Rendering (\d+) pane/i.exec(line);
  if(render)return {phase:'render',progress:47,total:+render[1],completed:0};
  const panes=/^LiquidGlass progress: render (\d+)\/(\d+)$/i.exec(line);
  if(panes && +panes[2]>0)return {phase:'render',completed:+panes[1],total:+panes[2],progress:Math.min(82,46+Math.round(36*+panes[1]/+panes[2]))};
  if(/^Composing final PDF/i.test(line))return {phase:'compose',progress:87};
  if(/^Running latexmk/i.test(line))return {phase:'latex',progress:28,route:'plain'};
  if(/^Saving PDF and SyncTeX/i.test(line))return {phase:'save',progress:96};
  return null;
}

function initialBuild(file='',paths={}) {
  return {phase:'idle',step:'inspect',route:'pending',progress:0,file,paths,detail:'',problems:[],
    pdf:false,busy:false,attempt:1,timeline:[]};
}
function tick(state,event,now=Date.now()) {
  const route=Object.hasOwn(routes,event.route)?event.route:state.route;
  const step=event.phase==='recapture'?'capture':event.phase || state.step;
  const recapture=event.recapture || (event.attempt>state.attempt);
  const stepChanged=step!==state.step||recapture||route!==state.route;
  const timeline=stepChanged?[...state.timeline,{step,title:captions[event.phase],time:now,attempt:event.attempt??state.attempt}].slice(-32):state.timeline;
  const paths=event.workspace?{...state.paths,temporary:event.workspace}:state.paths;
  const progress=recapture||route!==state.route?event.progress??state.progress:Math.max(state.progress,event.progress??0);
  const detail=event.tool?event.tool+(event.passNumber?' · 第 '+event.passNumber+' 轮':''):
    step==='capture'&&event.passNumber?'第 '+event.passNumber+' 轮 · 几何与引用':
    step==='render'&&event.total!==undefined?'玻璃片段 '+(event.completed??0)+' / '+event.total:
    event.recapture?'版面位置变化，重新采集':stepChanged?'':state.detail;
  return {route,step,paths,progress,timeline,phase:event.phase||state.phase,detail,
    attempt:event.attempt??state.attempt,lastEvent:now};
}
function routeStatus(state) {
  const sequence=routes[state.route].slice();
  if(state.route==='pending'&&state.step==='prepare'&&state.phase==='prepare')sequence.push('latex','save');
  const active=sequence.indexOf(state.step);
  return sequence.map((id,i)=>({id,label:captions[id],state:state.phase==='done'||i<active?'complete':
    i===active&&state.phase==='error'?'failed':i===active&&state.phase==='canceled'?'stopped':
    i===active&&state.busy?'current':'pending'}));
}
function diagnostics(log, main) {
  const results=[], seen=new Set();
  const rows=log.split(/\r?\n/);
  for (let i=0;i<rows.length;i++) {
    const line=rows[i].trim();
    const wrapped=!/\.(?:tex|sty|cls|bib|bbl|def|cfg|ltx|fd|aux):\d+:/i.test(line) && /^(?:\/|[A-Za-z]:\\)/.test(line) &&
      /^[^/:]*\.(?:tex|sty|cls|bib|bbl|def|cfg|ltx|fd|aux):\d+:/i.test(rows[i+1]??'') ? line+rows[++i] : line;
    const entry=/^(?:ERROR\s+-\s+)?(.+?\.(?:tex|sty|cls|bib|bbl|def|cfg|ltx|fd|aux)):(\d+):\s*(.*)$/i.exec(wrapped);
    const bib=!entry&&/\b(?:file|in)\s+['"]?([^'"]+\.bib)['"]?\s*[,;:]?\s*(?:at\s+)?line\s+(\d+)[: ,]+(.+)/i.exec(line);
    const match=entry||bib;
    if(!match)continue;
    const filename=match[1].trim().replace(/^['"]|['"]$/g,'');
    const issue=(match[3]||rows[i+1]||'').trim();
    if(!issue||/warning|rerun|fatal error occurred|emergency stop/i.test(issue))continue;
    const file=path.resolve(path.dirname(main),filename);
    const lineno=Math.max(1,Number(match[2]));
    const key=JSON.stringify([file,lineno,issue]);
    if(seen.has(key))continue;
    seen.add(key);
    results.push({file,line:lineno,message:issue});
    if(results.length>=30)break;
  }
  return results;
}

module.exports={ENGINES,captions,routes,buildSelection,selectionArguments,progressFor,initialBuild,tick,routeStatus,diagnostics};
