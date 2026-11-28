(() => {
  const vscode=acquireVsCodeApi(), M=globalThis.LiquidMaterial;
  globalThis.bindLiquidGlassFontScale(vscode);
  const $=id=>document.getElementById(id);
  const canvas=globalThis.createMaterialCanvas($('sample'));
  const fallback={silver:document.body.dataset.silver,frost:document.body.dataset.frost,default:document.body.dataset.default};
  const radiusLabels={default:'统一半径',north:'上边两角',south:'下边两角',west:'左边两角',east:'右边两角',
    northwest:'左上',northeast:'右上',southwest:'左下',southeast:'右下'};
  let input=M.initial(), tab='surface', frame, saving, toastTimer, serial=0, backdrop, imgStatus='';
  let comparing=false, draggedSlider, copying=false, copySerial=0, replyToCopy;
  let pdfMode=false, proofSerial=0, proof={};
  const send=(action,detail={})=>vscode.postMessage({action,...detail});
  const text=(id,value)=>{ $(id).textContent=value; };
  for (const [id,labels] of [['material',M.labels],['lift',M.liftLabels]]) {
    for (const [value,label] of Object.entries(labels)) $(id).append(new Option(label,value));
  }

  function postSettings() {
    clearTimeout(saving);
    saving=setTimeout(()=>send('save',{input}),180);
  }
  function selectImage() {
    serial++;
    backdrop=fallback[input.image.mode];
    imgStatus='';
    if (['file','folder','list'].includes(input.image.mode) && input.image.path) {
      if (M.imageToken(input.image)) {
        imgStatus='正在读取底图…';
        send('readImage',{image:input.image,id:serial});
      } else imgStatus='底图路径包含 TeX 特殊字符';
    }
    schedule();
  }
  function options(select,values,current) {
    for(const [key,value] of Object.entries(values))select.append(new Option(value,key));
    select.value=current;
  }
  function renderCode() {
    const mode=$('format').value;
    $('name-wrap').hidden=mode!=='named';
    const style=M.style(input,mode,$('name').value);
    if ($('code').textContent!==style) text('code',style);
    text('usage',{
      options:'用于已有 LiquidGlass 盒子的可选参数。',
      global:'放在加载 liquidglass 之后，作为全局材质设置。',
      named:'在盒子选项中填入生成的样式名称。'
    }[mode]);
    return style;
  }
  async function copyStyle() {
    if (copying) return;
    const mode=$('format').value, name=$('name').value;
    const snapshot=M.settings(input);
    const style=renderCode();
    copying=true;
    $('copy').setAttribute('aria-busy','true');
    text('copy-status','正在复制…');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(style);
      text('copy-status','样式已复制');
    } catch {
      const ok=await new Promise(resolve=>{
        const id=++copySerial;
        const timer=setTimeout(()=>replyToCopy?.(false),4500);
        replyToCopy=ok=>{
          clearTimeout(timer);
          replyToCopy=undefined;
          resolve(ok);
        };
        try {send('copy',{id,input:snapshot,mode,name});}
        catch {replyToCopy(false);}
      });
      if (ok) text('copy-status','样式已复制');
      else {
        const code=$('code');
        code.parentElement.focus({preventScroll:true});
        const selection=window.getSelection(), range=document.createRange();
        range.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(range);
        text('copy-status','剪贴板暂不可用。已选中样式，可按 ⌘C 或 Ctrl+C。');
      }
    } finally {
      copying=false;
      $('copy').removeAttribute('aria-busy');
    }
  }
  function render() {
    renderCode();
    const v=M.resolved(input);
    const official=input.image.mode==='reading';
    const ui={image:official?fallback[v.theme==='dark'?'frost':'silver']:backdrop,
      stage:$('stage').value,part:$('fragment').value,baseOnly:comparing};
    $('art').hidden=pdfMode;
    $('proof-stage').hidden=!pdfMode;
    $('compare').hidden=pdfMode;
    $('rebuild-proof').hidden=!pdfMode;
    $('zoom-proof').hidden=!pdfMode||!proof.url;
    $('live-preview').setAttribute('aria-pressed',String(!pdfMode));
    $('pdf-preview').setAttribute('aria-pressed',String(pdfMode));
    for (const theme of ['light','dark']) {
      const selected=input.material==='reading-window' && official && v.theme===theme;
      $('formal-'+theme).setAttribute('aria-pressed',String(selected));
    }
    if(pdfMode){
      renderProof(ui);
      return;
    }
    const result=canvas.draw(input,ui,schedule);
    const specimen=$('specimen');
    specimen.hidden=comparing;
    specimen.dataset.theme=v.frost?'frost':v.theme;
    specimen.dataset.tab=String(v['glass tab']);
    specimen.dataset.ribbon=String(v['theorem ribbon']);
    specimen.dataset.measured=String(v['theorem measure title']);
    specimen.style.setProperty('--accent-color','rgb('+M.rgb(v['theorem accent'],'LGRibbonGreen').join(',')+')');
    text('specimen-title',v['theorem ribbon']?(v['theorem language']==='zh'?'定理 1':'Theorem 1'):'LiquidGlass');
    text('source-kind',input.image.mode==='page'?'模拟页面采样':M.imageLabels[input.image.mode]);
    text('image-status',imgStatus);
    $('image-status').hidden=!imgStatus;
    text('render-state-label',comparing?'原始底图':'近似渲染');
    const low=result&&result.contrast<4.5;
    $('contrast').toggleAttribute('data-low',Boolean(result&&(!result.possible||low)));
    text('contrast',result
      ? '正文对比 ≈ '+result.contrast.toFixed(1)+':1'+(!result.possible?' · 超出目标范围':low?' · 偏低':'')
      : '');
  }
  function proofKey({stage=$('stage').value,part=$('fragment').value}={}) {
    return JSON.stringify([M.settings(input),stage,part]);
  }
  function renderProof(ui) {
    const image=$('proof-image');
    const stale=proof.key!==proofKey(ui);
    image.hidden=!proof.url;
    if(proof.url&&image.getAttribute('src')!==proof.url)image.src=proof.url;
    $('rebuild-proof').disabled=Boolean(proof.loading&&!stale);
    $('image-status').hidden=true;
    text('contrast','');
    text('source-kind',proof.version ? 'LiquidGlass '+proof.version : 'LaTeX 输出样片');
    text('render-state-label',stale?'参数已变动':proof.loading?'正在编译':proof.error?'编译失败':'PDF 实编译');
    text('proof-message',stale?'参数已变动。重新编译可查看当前效果。':proof.error||
      (proof.loading?'正在运行 LiquidGlass 与 XeLaTeX…':proof.pages>1?'第 '+proof.page+' / '+proof.pages+' 页':''));
  }
  function requestProof() {
    pdfMode=true;
    proof={id:++proofSerial,key:proofKey(),loading:true};
    $('proof-stage').removeAttribute('data-zoom');
    $('zoom-proof').setAttribute('aria-pressed','false');
    send('proof',{id:proof.id,input,stage:$('stage').value,part:$('fragment').value});
    schedule();
  }
  function schedule() {
    if (!frame)frame=requestAnimationFrame(()=>{frame=null;render();});
  }

  function parameterGuide(id,message,...controls) {
    const guide=document.createElement('p');
    guide.id=id+'-guide';
    guide.className='parameter-guide';
    guide.textContent=message;
    for (const control of controls) control.setAttribute('aria-describedby',guide.id);
    return guide;
  }
  function row(id,label,onReset) {
    const cell=document.createElement('div');cell.className='control';
    const title=document.createElement('label');title.htmlFor=id;title.textContent=label;
    cell.append(title);
    const reset=document.createElement('button');reset.type='button';reset.className='reset-value';reset.textContent='↶';
    reset.setAttribute('aria-label','恢复 '+label);
    reset.title='恢复 '+label;
    reset.addEventListener('click',onReset);
    cell.append(reset);
    return {cell,reset};
  }
  function finishDrag(event) {
    if (draggedSlider&&(!event||event.pointerId===draggedSlider.pointerId)) {
      draggedSlider.element.removeAttribute('data-dragging');
      draggedSlider=undefined;
    }
  }
  window.addEventListener('pointerup',finishDrag,true);
  window.addEventListener('pointercancel',finishDrag,true);
  window.addEventListener('blur',()=>finishDrag());
  document.addEventListener('visibilitychange',()=>{
    document.body.toggleAttribute('data-inactive',document.hidden);
    if (document.hidden) finishDrag();
  });

  function numeric(field,value,update,reset,active) {
    const {key,label,min,max,step,unit,hint}=field;
    const id='control-'+key.replaceAll(' ','-');
    const line=row(id,label,reset);
    line.reset.hidden=!active;
    const slider=document.createElement('div');slider.className='slider';
    const track=document.createElement('div');track.className='slider-track';
    const fill=document.createElement('span');fill.className='slider-fill';fill.setAttribute('aria-hidden','true');
    const range=document.createElement('input');
    range.id=id;range.type='range';range.min=min;range.max=max;range.step='any';range.value=value;
    track.append(fill,range);
    const box=document.createElement('span');box.className='value';
    const entry=document.createElement('input');
    entry.type='number';entry.min=min;entry.max=max;entry.step=key==='shadow steps'?'1':'any';
    entry.value=value;entry.setAttribute('aria-label',label+'数值');
    box.append(entry,document.createTextNode(unit||''));
    slider.append(track,box);
    function reflect() {
      slider.style.setProperty('--fraction',(Number(range.value)-min)/(max-min));
      range.setAttribute('aria-valuetext',range.value+(unit?' '+unit:''));
    }
    function commit(number) {
      const next=Math.max(min,Math.min(max,+number.toFixed(4)));
      range.value=next;entry.value=next;reflect();
      line.reset.hidden=false;
      update(next);
    }
    range.addEventListener('input',()=>commit(Math.round((Number(range.value)-min)/step)*step+min));
    range.addEventListener('pointerdown',event=>{
      if (!event.isPrimary||event.button!==0) return;
      finishDrag();
      draggedSlider={element:slider,pointerId:event.pointerId};
      slider.setAttribute('data-dragging','');
    });
    range.addEventListener('lostpointercapture',finishDrag);
    range.addEventListener('keydown',event=>{
      const offsets={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1,PageDown:-10,PageUp:10};
      if (event.key==='Home') commit(min);
      else if (event.key==='End') commit(max);
      else if (Object.hasOwn(offsets,event.key)) commit(Number(range.value)+step*offsets[event.key]);
      else return;
      event.preventDefault();
    });
    entry.addEventListener('input',()=>{
      if (entry.value && entry.validity.valid) {
        range.value=entry.value;reflect();line.reset.hidden=false;update(Number(entry.value));
      }
    });
    entry.addEventListener('blur',()=>{if(!entry.value||!entry.validity.valid)entry.value=range.value;});
    reflect();
    line.cell.append(slider,parameterGuide(id,hint,range,entry));
    return line.cell;
  }
  const hints={
    theme:'浅色用深字，深色用浅字。先选正文反差更清楚的一档。',
    blur:'值越高，底图细节越柔。想保留纹理就调低。',
    refraction:'值越高，靠近边缘的图案偏移越明显。切到测试网格更容易观察。',
    opacity:'0 保留原底色，1 完全覆上主题底色。想让文字更稳定，可先稍微调高。',
    saturation:'0 去掉颜色，1 保留原底图饱和度，超过 1 会增强颜色。',
    mask:'从左上到右下加重主题色。调高可让右下角的背景更安静。',
    grain:'值越高，表面颗粒越明显。细微磨砂可从 0.01 左右试起。',
    contrast:'设定正文目标对比度。调高会提亮浅色底或压暗深色底，1 关闭补偿。',
    sheen:'调整玻璃面上的柔光亮度。设为 0 时关闭柔光。',
    'sheen size':'值越小，亮斑越集中。值越大，光晕铺得越宽。',
    'sheen x':'移动柔光的水平中心。0 在左，1 在右。',
    'sheen y':'移动柔光的垂直中心。0 在上，1 在下。',
    'highlight rolloff':'压低过亮的反光，只作用于浅色材质。亮处刺眼时可小幅调高。',
    edge:'强化上边缘的反光。略高一些更容易看出玻璃厚度。',
    'edge bottom':'调节底边亮度。留少量高光可让底边有通透感。',
    'edge left':'调节左边缘亮度。可配合顶部高光模拟左上来光。',
    'edge right':'加深玻璃右边缘。背景较暗时建议降低，避免边缘过重。',
    'edge width':'调节边缘线宽，单位为 pt。减小更细腻，0 隐藏边线。',
    'edge color':'更改上、下和左边缘的反光色。可用 white 或 white!80!cyan 等 LaTeX 色值。',
    'edge shade color':'更改右侧暗线颜色。默认 LGShadow，换成接近底图的色调会更柔和。',
    'shadow profile':'经典曲线的暗部更集中，平滑曲线让阴影过渡更连贯。',
    shadow:'值越高，悬浮阴影越深。设为 0 可以单独观察接触阴影。',
    'shadow blur':'增大后阴影边缘向外散开，更像柔光下的浮起效果。',
    'shadow xshift':'正值向右，负值向左。可让阴影落在光源的反方向。',
    'shadow yshift':'正值向上，负值向下。想让样片向上浮起，可让阴影略往下。',
    'shadow spread':'正值向外扩，负值向内收。想收敛宽阴影时可稍微减小。',
    'shadow color':'两层阴影共用的颜色。可输入 LaTeX 色名或 xcolor 混色值。',
    'shadow steps':'层数越多，阴影过渡越细，真实编译的绘制量也越大。',
    'contact opacity':'控制贴着玻璃边缘的近场暗影。略加一点可让盒子更有落地感。',
    'contact blur':'控制近场暗影向外散开的距离。调低可保留清晰的贴边暗影。',
    'contact follows shadow':'开启后接触层跟随悬浮层的水平位移。手动调接触横移会解除跟随。',
    'contact xshift':'单独移动接触阴影。正值向右，负值向左。',
    'contact yshift':'单独改变接触阴影的高度。正值向上，负值向下。',
    'contact spread':'正值扩大贴边阴影，负值收紧。适合微调接触边的厚薄。',
    'image fit':'自选底图可保留比例并裁切，或铺满整个盒子。页面采样沿用页面位置。',
    'focus x':'仅用于自选底图的等比填充。0 保留左边，1 保留右边。',
    'focus y':'仅用于自选底图的等比填充。0 保留上边，1 保留下边。',
    'glass tab':'把已有盒子标题放进左上角的半透明标题签。',
    'theorem ribbon':'给 LiquidGlass 定理标题启用原生飘带。色调可在下方调整。',
    'theorem accent':'改变定理飘带主色。可输入 LGRibbonGreen 或 xcolor 混色值。',
    'theorem language':'切换飘带上的自动定理标签语言，例如「定理」或 Theorem。',
    'theorem measure title':'开启后按标题宽度调整飘带预留位置。长标题更适合开启。'
  };
  function fieldControl(field,value) {
    const {key,label,type}=field;
    const refresh=()=>{postSettings();schedule();};
    const update=val=>{input.values[key]=val;refresh();};
    const reset=()=>{delete input.values[key];refresh();inspector();};
    if (type==='number') return numeric({...field,hint:hints[key]},value,update,reset,Object.hasOwn(input.values,key));
    const id='control-'+key.replaceAll(' ','-');
    const line=row(id,label,reset);
    line.reset.hidden=!Object.hasOwn(input.values,key);
    let control;
    if (type==='choice') {
      control=document.createElement('select');
      options(control,field.values,value);
    } else {
      control=document.createElement('input');
      if(type==='flag'){control.type='checkbox';control.setAttribute('role','switch');control.checked=value;}
      else {control.type='text';control.value=value;control.maxLength=45;control.pattern='[A-Za-z][A-Za-z0-9_\\-]*(?:![0-9.]+(?:![A-Za-z][A-Za-z0-9_\\-]*)?)*';}
    }
    control.id=id;
    control.addEventListener('change',()=>{
      if(type==='flag'){
        if(key==='contact follows shadow'){
          if(control.checked)delete input.values['contact xshift'];
          else input.values['contact xshift']=M.resolved(input)['shadow xshift'];
          inspector();refresh();return;
        }
        if (control.checked)update(true); else reset();
      } else if(control.validity.valid&&M.settings({values:{[key]:control.value}}).values[key]!==undefined)update(control.value);
      else control.value=M.resolved(input)[key];
      line.reset.hidden=!Object.hasOwn(input.values,key);
    });
    line.cell.append(control,parameterGuide(id,hints[key],control));
    return line.cell;
  }
  function geometry() {
    const group=document.createElement('div');group.className='control geometry-group';
    const source=document.createElement('select');source.id='material-image';
    options(source,M.imageLabels,input.image.mode);
    const label=document.createElement('label');label.textContent='底图来源';label.htmlFor=source.id;
    source.addEventListener('change',()=>{input.image={mode:source.value,path:''};selectImage();postSettings();inspector();});
    group.append(label,source,parameterGuide(source.id,'页面采样沿用盒子所在位置。也可指定底图，路径可以相对于工程填写。',source));
    if(['file','folder','list'].includes(input.image.mode)){
      const line=document.createElement('div');line.className='pick';
      const file=document.createElement('input');file.type='text';file.value=input.image.path;
      file.setAttribute('aria-label','底图路径');file.maxLength=600;
      file.placeholder=input.image.mode==='list'?'用分号分隔路径':'相对于项目的路径';
      const pathGuide=parameterGuide('material-image-path',input.image.mode==='list'
        ? '用分号分隔图片路径，编译时循环取用。'
        : input.image.mode==='folder'?'选择工程里的图片目录，按顺序循环取用。':'填入工程中的图片路径，或直接选择文件。',file);
      const browse=document.createElement('button');browse.textContent='选择';
      file.addEventListener('change',()=>{input.image.path=file.value.trim();selectImage();postSettings();});
      browse.addEventListener('click',()=>send('chooseImage',{mode:input.image.mode}));
      line.append(file,browse); group.append(line,pathGuide);
    }
    return group;
  }
  function radiusControls() {
    const details=document.createElement('details');details.open=true;details.className='radius';
    const label=document.createElement('summary');label.textContent='圆角覆盖';details.append(label);
    details.append(parameterGuide('radius','先设四角的统一值，再用方位或单角覆盖。单角的优先级最高。',label));
    const resolved=M.corners(input.radii), projected={north:resolved[0],south:resolved[3],west:resolved[0],east:resolved[1],
      northwest:resolved[0],northeast:resolved[1],southeast:resolved[2],southwest:resolved[3]};
    for(const key of M.radiusKeys) {
      const value=input.radii[key]??(key==='default'?4:projected[key]);
      const hint=key==='default'?'设置四角的基础圆角。0 为直角。'
        : key.length>5?'单独调整'+radiusLabels[key]+'角。设为 0 可切成直角。'
        :'同时调整'+radiusLabels[key]+'。该侧如有单角覆盖，优先使用单角数值。';
      details.append(numeric({key:'radius '+key,label:radiusLabels[key],unit:'mm',min:0,max:100,step:.05,hint},value,
        val=>{input.radii[key]=val;postSettings();schedule();},()=>{
          delete input.radii[key];postSettings();schedule();inspector();
        },Object.hasOwn(input.radii,key)));
    }
    return details;
  }
  function inspector() {
    const focused=document.activeElement;
    const focusId=$('controls').contains(focused)
      ? focused.id||focused.closest('.control')?.querySelector('label')?.htmlFor
      : '';
    $('material').value=input.material;$('lift').value=input.lift;
    const v=M.resolved(input), section=M.sections.find(item=>item.id===tab);
    const controls=section.fields.map(field=>fieldControl(field,v[field.key]));
    if(tab==='shape')controls.unshift(geometry());
    if(tab==='shape')controls.push(radiusControls());
    $('controls').replaceChildren(...controls);
    if (focusId) $(focusId)?.focus({preventScroll:true});
    for (const item of $('tabs').children)item.setAttribute('aria-pressed',String(item.dataset.tab===tab));
  }
  for(const section of M.sections){
    const button=document.createElement('button');button.textContent=section.label;button.dataset.tab=section.id;
    button.addEventListener('click',()=>{tab=section.id;inspector();});
    $('tabs').append(button);
  }
  $('material').addEventListener('change',()=>{
    input.material=$('material').value;
    input.lift=M.settings({material:input.material}).lift;
    inspector();postSettings();schedule();
  });
  for (const theme of ['light','dark']) $('formal-'+theme).addEventListener('click',()=>{
    input=M.formal(theme);
    selectImage(); inspector(); postSettings();
    if (pdfMode) requestProof();
  });
  $('lift').addEventListener('change',()=>{
    input.lift=$('lift').value;inspector();postSettings();schedule();
  });
  $('reset').addEventListener('click',()=>{input.values=input.values.theme ? {theme:input.values.theme} : {};input.radii={};inspector();postSettings();schedule();});
  $('copy').addEventListener('click',copyStyle);
  $('build-panel').addEventListener('click',()=>send('buildPanel'));
  $('live-preview').addEventListener('click',()=>{
    if(proof.loading){send('cancelProof');proof={};}
    pdfMode=false;schedule();
  });
  $('pdf-preview').addEventListener('click',()=>{
    if(!proof.url||proof.key!==proofKey()){if(!pdfMode||!proof.loading||proof.key!==proofKey())requestProof();}
    else {pdfMode=true;schedule();}
  });
  $('rebuild-proof').addEventListener('click',requestProof);
  $('zoom-proof').addEventListener('click',()=>{
    const zoom=$('proof-stage').toggleAttribute('data-zoom');
    $('zoom-proof').setAttribute('aria-pressed',String(zoom));
    text('zoom-proof',zoom?'适合窗口':'放大');
  });
  $('compare').addEventListener('click',()=>{
    comparing=!comparing;
    $('compare').setAttribute('aria-pressed',String(comparing));
    document.body.toggleAttribute('data-comparing',comparing);
    schedule();
  });
  for(const id of ['stage','fragment','format','name'])$(id).addEventListener('input',schedule);

  window.addEventListener('message',({data})=>{
    if (!data) return;
    if (data.type==='copyResult'&&data.id===copySerial) replyToCopy?.(data.ok===true);
    if(data.type==='settings'){
      input=data.input?M.settings(data.input):M.initial();selectImage();inspector();
    }
    if(data.type==='picked'){input.image=data.image;selectImage();inspector();postSettings();}
    if(data.type==='image'&&data.id===serial){backdrop=data.url;imgStatus=data.error||'';schedule();}
    if(data.type==='proof'&&data.id===proof.id){proof={...proof,...data,loading:false};schedule();}
    if(data.type==='notice'){
      text('toast',data.message);$('toast').hidden=false;clearTimeout(toastTimer);
      toastTimer=setTimeout(()=>{$('toast').hidden=true;},3200);
    }
  });
  inspector();selectImage();send('ready');
})();
