(() => {
  const vscode = acquireVsCodeApi();
  globalThis.bindLiquidGlassFontScale(vscode);
  const S = globalThis.LiquidSource;
  const $ = id => document.getElementById(id);
  const q = selector => [...document.querySelectorAll(selector)];
  const glass = globalThis.createGlassRenderer($('material'));
  const engineNames = { xelatex:'XeLaTeX', pdflatex:'pdfLaTeX', lualatex:'LuaLaTeX' };
  let capture, draft = '', model, trusted = false, engine = 'xelatex', followProject = false, native, toastTimer, frame;
  let mode = 'live', zoom = 100, buildState, editingTimer;
  const openSections = new Map();
  const describe = () => S.describe(draft,capture);
  const post = (action, data = {}) => vscode.postMessage({ action, id:capture?.id, ...data });
  const text = (id,value) => { $(id).textContent = value ?? ''; };
  function toast(message) {
    text('toast',message);
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; },4300);
  }

  function view(value) {
    mode = value;
    $('live').hidden = mode === 'native';
    $('native').hidden = mode === 'live';
    $('views').classList.toggle('compare',mode === 'compare');
    q('[data-mode]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.mode === mode)));
  }

  function actions() {
    const busy = native?.status === 'busy';
    const stale = capture?.stale;
    const dirty = draft !== capture?.source;
    $('verify').disabled = !capture || (!busy && (!trusted || stale || !draft.trim()));
    $('verify').querySelector('span').textContent = busy ? '停止验证' : 'TeX 验证';
    $('verify').title = trusted ? '' : 'TeX 验证需要信任工作区';
    $('apply').disabled = !dirty || capture?.demo || stale || !draft.trim();
    $('compile-all').disabled = !buildState?.busy && (!capture || capture.demo || stale || !trusted);
    text('compile-all',buildState?.busy ? '停止整篇' : '编译整篇');
    $('build-pdf').hidden = !buildState?.pdf || capture?.demo;
    $('reset').disabled = !dirty;
    $('dirty').hidden = !dirty && !stale;
    text('dirty',stale ? '源代码已变化' : '草稿');
    text('apply-help',stale ? '重新载入选区以恢复编辑。' : capture?.demo ? '样片参数可复制到 LaTeX。' : '应用后可在编辑器中撤销。');
    if (native?.status === 'ready') {
      const outdated = native.source !== draft || (!followProject && native.engine !== engine) || native.followProject !== followProject || stale;
      text('native-tag',outdated ? '早先的 TeX 结果' : (engineNames[native.engine] || '真实 TeX') + (native.cacheHit ? ' · 已缓存' : ''));
    }
  }

  function svg(tag,attributes) {
    const element = document.createElementNS('http://www.w3.org/2000/svg',tag);
    for (const [key,value] of Object.entries(attributes)) element.setAttribute(key,String(value));
    return element;
  }

  function drawTikz({ shapes,points }) {
    const all = [...Object.values(points)];
    for (const shape of shapes) {
      if (shape.vertex) all.push(...shape.vertex);
      if (shape.p) all.push(shape.p);
      if (shape.r) all.push([shape.p[0]+shape.r,shape.p[1]+shape.r],[shape.p[0]-shape.r,shape.p[1]-shape.r]);
    }
    if (!all.length) { $('drawing').replaceChildren(); return; }
    const loX = Math.min(...all.map(p => p[0])), hiX = Math.max(...all.map(p => p[0]));
    const loY = Math.min(...all.map(p => p[1])), hiY = Math.max(...all.map(p => p[1]));
    const margin = Math.max(hiX-loX,hiY-loY,.5)*.18;
    const pic = svg('svg',{viewBox:[loX-margin,-hiY-margin,hiX-loX+2*margin,hiY-loY+2*margin].join(' '), role:'img', 'aria-label':'TikZ 近似图形'});
    for (const shape of shapes) {
      const paint = {fill:shape.fill,stroke:shape.stroke,'stroke-width':shape.width,'vector-effect':'non-scaling-stroke','stroke-linejoin':'round'};
      let item;
      if (shape.type === 'rect') {
        const [a,b] = shape.vertex;
        item = svg('rect',{x:Math.min(a[0],b[0]),y:-Math.max(a[1],b[1]),width:Math.abs(a[0]-b[0]),height:Math.abs(a[1]-b[1]),...paint});
      } else if (shape.type === 'line') {
        item = svg(shape.closed ? 'polygon' : 'polyline',{points:shape.vertex.map(([x,y]) => x + ',' + -y).join(' '),...paint});
      } else if (shape.type === 'circle') {
        item = svg('circle',{cx:shape.p[0],cy:-shape.p[1],r:shape.r,...paint});
      } else {
        item = svg('text',{x:shape.p[0],y:-shape.p[1],fill:'currentColor','font-size':margin*.5,'text-anchor':'middle','dominant-baseline':'central'});
        item.textContent = shape.text;
      }
      pic.append(item);
    }
    $('drawing').replaceChildren(pic);
  }

  function renderLive() {
    if ($('code').value !== draft.replace(/\r\n/g,'\n')) $('code').value = draft;
    text('source-lines',draft ? draft.split('\n').length + ' 行' : '');
    const { kind,properties } = model;
    const values = Object.fromEntries(properties.map(prop => [prop.key,prop.value]));
    $('stage').className = 'stage ' + kind + (model.ornate ? ' ornate' : '');
    $('stage-art').hidden = kind !== 'glass' && kind !== 'box';
    $('material').hidden = kind !== 'glass';
    $('drawing').hidden = kind !== 'tikz' || !model.shapes.length;
    $('specimen').hidden = kind !== 'glass' && kind !== 'box';
    $('live-empty').hidden = kind !== 'tex' && !(kind === 'tikz' && !model.shapes.length);
    text('fidelity',kind === 'tex' ? '仅 TeX 预览' : model.partial ? '实时近似 · 部分语义' : '实时近似 · 无 TeX');
    if (kind === 'glass' || kind === 'box') {
      text('preview-title',model.title || '');
      text('preview-body',model.body.slice(0,220));
      const style = $('specimen').style;
      style.removeProperty('background-color');
      style.removeProperty('border-color');
      style.removeProperty('border-width');
      style.removeProperty('border-radius');
      style.removeProperty('padding');
      if (kind === 'glass') {
        glass.setScene(capture?.backdrop);
        glass.draw(values);
        q('[data-preset]').forEach(button => button.setAttribute('aria-pressed',String(
          S.presets[button.dataset.preset].every((value,i)=>value===values[S.glassKeys[i]]))));
      }
      else {
        const px = key => properties.find(prop => prop.key === key)?.px + 'px';
        style.borderRadius = px('arc');
        style.borderWidth = px('boxrule');
        style.padding = 'calc(12px + ' + px('boxsep') + ')';
        style.borderColor = values.colframe;
        style.backgroundColor = values.colback + Math.round(255*values.opacityback).toString(16).padStart(2,'0');
      }
    }
    if (kind === 'tikz' && model.shapes.length) drawTikz(model);
    actions();
  }

  function queueRender() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = null; renderLive(); });
  }

  function change(key,value) {
    const next = S.change(draft,key,value,capture);
    if (next === draft) return;
    draft = next;
    model = describe();
    queueRender();
  }

  function inspector() {
    const headings = { glass:['Material Lab','透光材质'],box:['盒子属性','tcolorbox'],tikz:['图形属性','TikZ'],tex:['选区预览','LaTeX'] };
    text('inspector-title',headings[model.kind][0]);
    text('kind',headings[model.kind][1]);
    $('presets').hidden = model.kind !== 'glass';
    $('property-help').hidden = model.properties.length > 0;
    text('property-help',model.kind === 'tikz' ? '节点的字面量坐标和显式线宽可调。' : '此选区需由 TeX 解析。');
    const controls = model.properties.map((prop,index) => {
      const group = document.createElement('div');
      group.className = 'param';
      const label = document.createElement('label');
      label.htmlFor = 'prop-' + index;
      label.textContent = prop.label;
      group.append(label);
      if (!prop.editable) {
        const reason = document.createElement('small');
        reason.textContent = '由 TeX 解析';
        group.append(reason);
      } else if (prop.type === 'color') {
        const select = document.createElement('select');
        select.id = label.htmlFor;
        if (!Object.values(S.colors).includes(prop.value)) select.append(new Option('当前色',prop.value));
        for (const [name,value] of Object.entries(S.colors)) select.append(new Option(name,value));
        select.value = prop.value;
        select.addEventListener('change',() => change(prop.key,select.value));
        group.append(select);
      } else {
        const value = document.createElement('span');
        value.className = 'value';
        const number = document.createElement('input');
        number.type = 'number';
        number.min = prop.min;
        number.max = prop.max;
        number.step = 'any';
        number.value = prop.value;
        number.setAttribute('aria-label',prop.label + '数值');
        value.append(number,document.createTextNode(prop.unit));
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.id = label.htmlFor;
        slider.min = prop.min;
        slider.max = prop.max;
        slider.step = 'any';
        slider.value = prop.value;
        const paintRange = () => slider.style.setProperty('--amount',(100*(Number(slider.value)-prop.min)/(prop.max-prop.min))+'%');
        paintRange();
        slider.addEventListener('input',() => {
          const n = Number(slider.value);
          const snapped = Number((Math.round(n/prop.step)*prop.step).toFixed(4));
          number.value = Math.max(prop.min,Math.min(prop.max,snapped));
          paintRange();
          change(prop.key,number.value);
        });
        number.addEventListener('input',() => {
          if (number.value && number.validity.valid) { slider.value = number.value; paintRange(); change(prop.key,number.value); }
        });
        number.addEventListener('change',() => {
          if (!number.value || !number.validity.valid) number.value = model.properties.find(item => item.key === prop.key)?.value ?? prop.value;
        });
        group.append(value,slider);
      }
      return group;
    });
    const sections = [['透光',controls.slice(0,3)],['光照与轮廓',controls.slice(3)]];
    if (model.kind !== 'glass') { $('properties').replaceChildren(...controls); return; }
    $('properties').replaceChildren(...sections.map(([name,items])=>{
      const detail = document.createElement('details');
      detail.className = 'prop-group';
      detail.open = openSections.get(name) ?? true;
      detail.addEventListener('toggle',()=>openSections.set(name,detail.open));
      const summary = document.createElement('summary');
      summary.textContent = name;
      const grid = document.createElement('div');
      grid.className = 'prop-grid';
      grid.append(...items);
      detail.append(summary,grid);
      return detail;
    }));
  }

  function showNative(message) {
    native = message;
    $('result').hidden = !message.png;
    if (message.png) $('result').src = message.png;
    else $('result').removeAttribute('src');
    $('feedback').hidden = !!message.png;
    $('log').hidden = message.status !== 'error';
    $('page-tools').hidden = message.status !== 'ready';
    if (message.status === 'ready') {
      text('page-number',message.page + ' / ' + message.pages);
      $('previous').disabled = message.page <= 1;
      $('next').disabled = message.page >= message.pages;
    }
    const copy = {
      busy:['TeX 正在编译',engineNames[message.engine] + ' · 局部预览'],
      ready:['PDF 已生成','可使用「打开 PDF」查看完整结果。'],
      error:['选区编译失败',(message.line ? '选区第 ' + message.line + ' 行 · ' : '') + (message.message || '')],
      canceled:['验证已停止','可随时再次运行 TeX 验证。'],
      idle:['验证当前草稿','按下「TeX 验证」后，结果会显示在这里。']
    }[message.status];
    text('native-title',copy[0]);
    text('native-detail',copy[1]);
    text('native-tag',message.status === 'busy' ? '编译中' : '真实 TeX');
    if (message.status === 'busy' && mode === 'live') view(model.kind === 'tex' ? 'native' : 'compare');
    actions();
  }

  window.addEventListener('message',({data}) => {
    if (data.type === 'build-state') {
      buildState = data.state;
      $('build-strip').hidden = !buildState.busy && !['done','error','canceled'].includes(buildState.phase);
      $('build-progress').value = buildState.progress;
      text('build-caption',buildState.title + (buildState.file ? ' · ' + buildState.file : ''));
      actions();
    }
    if (data.type === 'project-look' && data.id === capture?.id) {
      Object.assign(capture,{beautybook:data.beautybook,backdrop:data.backdrop});
      text('backdrop',capture.backdrop ? '项目底图' : '工作台底图');
      model = describe();
      inspector();
      queueRender();
    }
    if (data.type === 'settings') { trusted = data.trusted; engine = data.engine; followProject = Boolean(data.followProject); text('engine',followProject ? '项目引擎' : engineNames[engine]); actions(); }
    let load = data.type === 'target';
    if (data.type === 'source-update' && data.previousId === capture?.id) {
      if (draft === capture.source && !capture.stale) load = true;
      else {
        capture.stale = true;
        if (native.status === 'busy') showNative({status:'canceled'});
        actions();
      }
    }
    if (data.type === 'location' && capture?.id === data.id) text('location',data.location + (data.expanded ? ' · 已扩展环境' : ''));
    if (load) {
      capture = data;
      draft = data.source;
      model = describe();
      text('file',data.file);
      text('backdrop',data.backdrop ? '项目底图' : '工作台底图');
      $('file').disabled = data.demo;
      text('location',data.location + (data.expanded ? ' · 已扩展环境' : ''));
      view(model.kind === 'tex' ? 'native' : 'live');
      showNative({status:'idle'});
      inspector();
      renderLive();
    }
    if (data.type === 'stale') { if (capture) capture.stale = true; actions(); }
    if (data.type === 'applied' && capture?.id === data.id) {
      const clean = draft.replace(/\r\n/g,'\n') === data.source.replace(/\r\n/g,'\n');
      capture.source = data.source;
      if (clean) draft = data.source;
      model = describe();
      renderLive();
      toast('已应用到编辑器');
    }
    if (data.type === 'native' && capture?.id === data.id) showNative(data);
    if (data.type === 'notice') toast(data.message);
  });
  q('[data-mode]').forEach(button => button.addEventListener('click',() => view(button.dataset.mode)));
  q('[data-action]').forEach(button => button.addEventListener('click',() => post(button.dataset.action,{source:draft})));
  q('[data-preset]').forEach(button => button.addEventListener('click',() => {
    S.presets[button.dataset.preset].forEach((value,i) => change(S.glassKeys[i],value));
    inspector();
  }));
  $('verify').addEventListener('click',() => post(native?.status === 'busy' ? 'cancel' : 'render',{source:draft}));
  $('apply').addEventListener('click',() => post('apply',{source:draft}));
  $('reset').addEventListener('click',() => { draft = capture.source; model = describe(); inspector(); renderLive(); });
  $('code').addEventListener('input',()=>{
    if (!capture) return;
    draft = $('code').value;
    actions();
    clearTimeout(editingTimer);
    editingTimer = setTimeout(()=>{ model = describe(); inspector(); queueRender(); },90);
  });
  $('compile-all').addEventListener('click',()=>post(buildState?.busy ? 'cancelBuild' : 'build',{dirty:draft !== capture?.source}));
  const setZoom = value => {
    zoom = Math.max(75,Math.min(200,value));
    text('zoom-level',zoom+'%');
    for (const id of ['stage','paper']) $(id).style.setProperty('--zoom',zoom/100);
    $('zoom-in').disabled = zoom >= 200;
    $('zoom-out').disabled = zoom <= 75;
  };
  $('zoom-in').addEventListener('click',()=>setZoom(zoom+25));
  $('zoom-out').addEventListener('click',()=>setZoom(zoom-25));
  $('zoom-level').addEventListener('click',()=>setZoom(100));
  $('previous').addEventListener('click',() => post('page',{page:native.page-1}));
  $('next').addEventListener('click',() => post('page',{page:native.page+1}));
  post('ready');
})();
