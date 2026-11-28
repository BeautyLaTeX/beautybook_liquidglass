const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const S = require('../core/source');
const P = require('../core/preview');
const B = require('../build-ui');

test('workspace choices, launch arguments, build progress and diagnostics keep their contract', () => {
  assert.deepEqual(B.buildSelection(),{ engine:'xelatex',shellEscape:false,followProject:false });
  assert.deepEqual(B.selectionArguments({ followProject:true }),['--engine','auto']);
  assert.deepEqual(B.selectionArguments({ engine:'lualatex',shellEscape:true }),['--engine','lualatex','--shell-escape']);
  assert.deepEqual(B.progressFor('LiquidGlass progress: render 2/4'),{ phase:'render',completed:2,total:4,progress:64 });
  assert.equal(B.diagnostics('./child.tex:12: Undefined control sequence.', '/tmp/main.tex')[0].line,12);
});

test('subselection expands to related TikZ code and comments and verbatim are ignored', () => {
  const code = String.raw`\begin{document}
% \begin{tikzpicture}
\verb|\begin{glassbox}|
\begin{verbatim}
\begin{equation}
\end{verbatim}
\begin{tikzpicture}
  \coordinate (A) at (0,0);
  \draw (A) -- (2,2);
\end{tikzpicture}
\end{document}`;
  const start = code.indexOf('\\draw') + 6;
  const scope = S.fragment(code,start,start+4);
  assert.equal(scope.expanded,true);
  assert.equal(code.slice(scope.start,scope.end).split('\n')[0],'\\begin{tikzpicture}');
  assert.equal(S.environments(code).length,3);
  assert.equal(S.fragment(code,0,0),null);
});

test('tcolorbox edits preserve comments, nested option lists, duplicate keys and dimensions', () => {
  const code = String.raw`\begin{tcolorbox}[title={Hi, [a]},arc=1pt,% keep
  arc=2mm,colback=blue!10,tikznode={foo,bar}]
  Body
\end{tcolorbox}`;
  assert.equal(S.describe(code).title,'Hi, [a]');
  assert.equal(S.describe(code).properties[0].value,2);
  assert.equal(S.change(code,'arc',4),code.replace('arc=2mm','arc=4mm'));
  assert.equal(S.change(code,'opacityback',.5),code.replace('tikznode={foo,bar}]','tikznode={foo,bar}, opacityback=0.5]'));
  assert.match(S.change('\\begin{tcolorbox}\nbody\n\\end{tcolorbox}','arc',5),/\[arc=5mm\]/);
});

test('material controls round trip and keep arbitrary macros untouched', () => {
  const changed = S.change(S.sample,'lg opacity',.35);
  assert.equal(S.describe(changed).properties.find(p=>p.key === 'lg opacity').value,.35);
  assert.equal(S.change(changed,'lg opacity',1.5),changed);
  const dynamic = S.sample.replace('lg opacity=.22','lg opacity=\\myopacity');
  assert.equal(S.change(dynamic,'lg opacity',.99),dynamic);
});

test('TikZ source mappings update rendered geometry and dimensions', () => {
  const code = String.raw`\begin{tikzpicture}
  \coordinate (A) at (0,0);
  \node (B) at (2,1) {B};
  \draw[red,line width=1pt] (A)--(B);
  \draw (2,2) circle (0.5);
\end{tikzpicture}`;
  const model = S.describe(code);
  assert.equal(model.shapes.length,3);
  assert.deepEqual(S.describe(S.change(code,'coord-0',1.25)).shapes[1].vertex[0],[1.25,0]);
  const width = model.properties.at(-1).key;
  assert.match(S.change(S.change(code,'coord-0',-4),width,2),/line width=2pt/);
  const naked = String.raw`\coordinate (A) at (2,1); \draw (A)--(3,0);`;
  assert.match(S.change(naked,'coord-0',3),/at \(3,1\)/);
});

test('partial wrapper inherits macros, adds libraries and reports the exact line offset', () => {
  const document = String.raw`% \begin{document}
\documentclass{article}
\newcommand{\NodeName}{Inherited}
\begin{document}
\end{document}`;
  const code = String.raw`\node (start) at (0,0) {\NodeName};
\node[right=of start] (end) {B};
\draw[-{Stealth}] (start)--(end);`;
  const plan = P.wrapper(code,P.preamble(document));
  assert.match(plan.text,/\\newcommand\{\\NodeName\}/);
  assert.match(plan.text,/usetikzlibrary\{arrows.meta,positioning\}/);
  assert.equal(plan.text.split('\n')[plan.lineOffset],code.split('\n')[0]);
  assert.match(P.wrapper('\\frac{1}{2}').text,/\\\[\n\\frac/);
  assert.match(P.wrapper('\\begin{axis}\\addplot coordinates {(0,0) (1,1)};\\end{axis}').text,/begin\{tikzpicture\}/);
});

test('Beautybook restores only the selected body state', () => {
  const code = String.raw`\documentclass{beautybook}
\begin{document}
\frontmatter
% \BeautyGlassOn
\mainmatter
\BeautyGlassOff
\begin{tcolorbox}Chosen\end{tcolorbox}
\backmatter
\end{document}`;
  const state = P.bodyContext(code,code.indexOf('Chosen'));
  assert.equal(state,'\\mainmatter\n\\BeautyGlassOff');
  assert.match(P.wrapper('Fragment',P.preamble(code),false,false,state).text,/\\begin\{document\}\n\\mainmatter\n\\BeautyGlassOff/);
  assert.equal(P.wrapper(code).text,code);
});

test('native TeX verifies fragment cases and isolates generated files', { skip:!process.env.LG_TEX_TEST }, async t => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(),'lg-studio-test-'));
  t.after(() => fs.rm(storage,{recursive:true,force:true}));
  const extension = path.resolve(__dirname,'..');
  const base = { extension,storage,env:process.env,python:async()=>process.env.LG_TEST_PYTHON || 'python3',
    findDriver:async()=>null,engine:'pdflatex' };
  const cases = [
    ['xf',String.raw`\frac{1}{2}`,{engine:'xelatex'}],
    ['tikz',String.raw`\draw[blue,line width=2pt] (0,0) rectangle (4,2);\node at (2,1) {\Note};`,
     {engine:'lualatex', inherited:String.raw`\documentclass{article}\newcommand{\Note}{Local Context}`}],
    ['plot',String.raw`\begin{axis}\addplot coordinates {(0,0) (1,1)};\end{axis}`,{}],
    ['box',String.raw`\begin{tcolorbox}[enhanced,title={Preflight},arc=4mm] Text.\end{tcolorbox}`,{}],
    ['glass',S.sample,{demo:true}],
    ['pages',String.raw`Page one.\newpage Page two.`,{}]
  ];
  for (const [name,fragment,options] of cases) {
    await t.test(name,async () => {
      const compiled = await P.compile({...base,...options,fragment});
      assert.match((await fs.readFile(compiled.pdf)).toString('ascii',0,9),/^%PDF/);
      assert.ok(compiled.page);
      assert.ok(compiled.dir.startsWith(storage));
      if (name === 'pages') {
        assert.equal(compiled.pages,2);
        assert.ok(await P.rasterize(compiled.pdf,2,compiled.options));
      }
      if (name === 'glass') assert.match(compiled.log,/1 fragments/);
    });
  }
  await t.test('project-defined glass and relative registered image retain their native render',async () => {
    const project = path.join(storage,'project with spaces');
    await fs.mkdir(path.join(project,'images'),{recursive:true});
    await fs.copyFile(path.join(extension,'media','lab-scene.png'),path.join(project,'images','local.png'));
    const inherited = String.raw`\documentclass{article}
\usepackage{liquidglass}
\newtcolorbox{localpane}{liquid glass,lg image=images/local.png}`;
    const fragment = String.raw`\begin{localpane}Native material\end{localpane}`;
    const entry = await P.compile({...base,fragment,inherited,mainDir:project,project,
      env:{...process.env,TEXINPUTS:path.join(extension,'runtime','glass')+path.delimiter}});
    assert.ok(entry.page);
    assert.match(entry.log,/1 fragments/);
    assert.deepEqual(await fs.readdir(project),['images']);
  });
  await t.test('errors map back to the requested fragment and clean their stage',async () => {
    const count = (await fs.readdir(storage)).length;
    await assert.rejects(P.compile({...base,fragment:'First line.\n\\missingcommand'}),error=>error.line === 2);
    assert.equal((await fs.readdir(storage)).length,count);
  });
  await t.test('an aborted process exits promptly',async () => {
    const controller = new AbortController();
    const processRun = P.run(process.execPath,['-e','setTimeout(() => {},5000)'],
      {cwd:storage,env:process.env,signal:controller.signal});
    setTimeout(() => controller.abort(),80);
    await assert.rejects(processRun,/已取消/);
  });
});

test('Beautybook inherited glass overrides preserve the native fancybox', () => {
  const input = String.raw`\begin{fancybox}
  \[a^2+b^2=c^2\]
\end{fancybox}`;
  const options = {beautybook:true};
  assert.equal(S.describe(input,options).ornate,true);
  const changed = S.change(input,'lg refraction',.8,options);
  assert.match(changed,/\\begin\{fancybox\}\[lg refraction=0.8\]/);
  assert.equal(S.describe(changed,options).properties.find(p=>p.key==='lg refraction').value,.8);
  assert.equal(S.describe(input).kind,'tex');
});

const M=require('../core/material');
test('material controls cover the public keys including the 2.0 renderer',async()=>{
  const schema = new Set(M.sections.flatMap(section=>section.fields.map(field=>field.key)));
  schema.add('radius').add('image').add('lift').add('material');
  const listedStyles = new Set(['frosted','clear','reference','luminous','shadow opacity']);
  for (const filename of ['liquidglass.sty','liquidglass-material.tex','liquidglass-shadow.tex','liquidglass-theorems.tex']) {
    const input=await fs.readFile(path.resolve(__dirname,'../runtime/glass',filename),'utf8');
    for (const match of input.matchAll(/^\s+lg ([a-z ]+?)\/\.(?:store in|style|is choice|code)=?/gm)) {
      assert.ok(schema.has(match[1])||listedStyles.has(match[1]),match[1]);
    }
  }
  const input=M.initial();
  input.values.renderer='legacy';
  input.values.blur=4.5;input.values.refraction=1.62;input.values['edge width']=1.3;
  input.values['shadow blur']=6;input.values['shadow steps']=16;
  input.radii={default:3,north:5,northwest:0,east:2};
  input.image={mode:'list',path:'one.png;two.png'};
  const output=M.style(input);
  assert.match(output,/lg renderer=legacy/);
  assert.match(output,/lg blur=4\.5[,\n]/);
  assert.match(output,/lg refraction=1\.62[,\n]/);
  assert.match(output,/lg edge width=1\.3pt/);
  assert.match(output,/lg shadow blur=6mm/);
  assert.match(output,/lg radius=\{default=3mm, north=5mm, east=2mm, northwest=0mm\}/);
  assert.match(output,/lg image=\{@list:one\.png;two\.png\}/);
  assert.doesNotMatch(output,/\\begin|\\end/);
  assert.match(M.style(input,'named','mac cloud'),/^\\tcbset\{mac cloud\/\.style=\{/);
  assert.match(M.style(input,'global'),/^\\glasssetup\{/);
  assert.deepEqual(M.corners(input.radii),[0,2,2,3]);
  assert.equal(M.resolved(input)['contact follows shadow'],false);
  assert.equal(M.resolved(M.settings({material:'reading'}))['contact follows shadow'],true);
});

const { proofDocument, proofPage } = require('../core/material-proof');
test('the approved reading preset is the Lab default and proof selects actual fragment pages', ()=>{
  const input = M.initial();
  assert.equal(input.material,'reading-window');
  assert.equal(M.resolved(input)['shadow profile'],'contour');
  assert.match(proofDocument(input,'grid','middle'),/lg material=reading-window,\s*lg lift=float,\s*lg image=\{@reading\}/);
  assert.match(proofDocument(input,'grid','middle'),/\\tcbbreak/);
  assert.match(proofDocument(M.formal('dark'),'natural','full'),/lg theme=dark/);
  assert.equal(M.resolved(M.formal('dark')).frost,true);
  assert.equal(M.resolved(M.formal('dark')).contrast,4.5);
  assert.equal(M.resolved(M.formal()).blur,.48);
  assert.doesNotMatch(proofDocument(input,'natural','full'),/\\tcbbreak/);
  assert.equal(proofPage('middle',3),2);
  assert.throws(()=>proofPage('first',1));
});

test('material proof uses packaged 2.0.2 and renders full and cross-page samples',
    {skip:!process.env.LG_TEX_TEST},async t=>{
  const storage=await fs.mkdtemp(path.join(os.tmpdir(),'lg-proof-test-'));
  t.after(()=>fs.rm(storage,{recursive:true,force:true}));
  const extension=path.resolve(__dirname,'..');
  for (const [theme,stage,part,expected] of [['light','paper','full',1],['dark','paper','full',1],['dark','grid','middle',3]]) {
    const fragment=proofDocument(M.formal(theme),stage,part);
    const result=await P.compile({extension,storage,assetRoot:storage,demo:true,dpi:200,engine:'xelatex',
      env:process.env,fragment,python:async()=>process.env.LG_TEST_PYTHON || 'python3'});
    assert.match(result.log,/LiquidGlass 2\.0\.2/);
    assert.match(result.log,new RegExp(expected+' fragments'));
    assert.equal(result.pages,expected);
    const page=proofPage(part,result.pages);
    assert.ok(page===1 ? result.page : await P.rasterize(result.pdf,page,result.options));
  }
});

test('pipeline handles both routes, capture retries and real work directories',()=>{
  let run={...B.initialBuild(),busy:true,started:10};
  run={...run,...B.tick(run,{phase:'prepare',route:'plain',progress:10},11)};
  run={...run,...B.tick(run,B.progressFor('LiquidGlass stage: {"phase":"latex","route":"plain","workspace":"/tmp/stage"}'),12)};
  assert.equal(run.paths.temporary,'/tmp/stage');
  assert.equal(B.routeStatus(run).find(s=>s.state==='current').id,'latex');
  assert.equal(B.routeStatus(run).at(-1).id,'save');
  run={...run,...B.tick(run,B.progressFor('LiquidGlass stage: {"phase":"capture","route":"glass"}'),13)};
  assert.equal(run.route,'glass');
  run={...run,...B.tick(run,B.progressFor('Composing final PDF'),14)};
  run={...run,...B.tick(run,B.progressFor('Layout changed during final composition; recapturing positions'),15)};
  assert.equal(run.progress,16);
  assert.equal(B.routeStatus(run).find(s=>s.state==='current').id,'capture');
  assert.equal(B.routeStatus({...run,phase:'error'}).find(s=>s.state==='failed').id,'capture');
  assert.equal(run.timeline.length,5);
});

test('generated style compiles using the actual package and no example box in the output',
    {skip:!process.env.LG_TEX_TEST},async t=>{
  const storage=await fs.mkdtemp(path.join(os.tmpdir(),'lg-style-test-'));
  t.after(()=>fs.rm(storage,{recursive:true,force:true}));
  const input=M.initial();
  input.image={mode:'silver',path:''};
  input.material='luminous';
  Object.assign(input.values,{blur:2.1,refraction:1.2,opacity:.24,'edge width':.5,mask:.15,
    sheen:.35,'shadow profile':'smooth','contact xshift':.2,'contact opacity':.12,'shadow steps':8});
  input.radii={default:3,northwest:0,northeast:5};
  const entries=M.style(input,'named','validation style');
  const source='\\begin{glassbox}[validation style]Control specimen.\\end{glassbox}';
  const extension=path.resolve(__dirname,'..');
  const result=await P.compile({extension,storage,engine:'xelatex',env:process.env,fragment:source,
    inherited:'\\documentclass{article}\n\\usepackage{liquidglass}\n'+entries,
    python:async()=> 'python3', findDriver:async()=>null});
  assert.match(result.log,/1 fragments/);
  assert.ok(result.page);
});
