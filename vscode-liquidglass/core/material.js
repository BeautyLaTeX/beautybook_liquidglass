(function (root, factory) {
  if (typeof module === 'object') module.exports = factory();
  else root.LiquidMaterial = factory();
})(globalThis, () => {
  const number = (key,label,min,max,step,value,unit='') => ({key,label,min,max,step,value,unit,type:'number'});
  const choice = (key,label,values,value) => ({key,label,values,value,type:'choice'});
  const color = (key,label,value) => ({key,label,value,type:'color'});
  const flag = (key,label) => ({key,label,value:false,type:'flag'});
  const sections = [
    { id:'surface', label:'材质', fields:[
      choice('theme','明暗主题',{light:'浅色 · 深色字',dark:'深色'},'light'),
      choice('renderer','PDF 渲染模式',{auto:'按当前材质',legacy:'1.6.x 兼容'},'auto'),
      number('blur','模糊',0,30,.05,2.4,'mm'),
      number('refraction','边缘折射',0,10,.01,.35,'mm'),
      number('opacity','主题色覆层',0,1,.01,.3),
      number('saturation','色彩饱和度',0,3,.01,1.08),
      number('mask','渐变蒙版',0,1,.01,0),
      number('grain','颗粒',0,1,.001,.012),
      number('contrast','最低文字对比度',1,21,.05,7)
    ]},
    { id:'illumination', label:'光照', fields:[
      choice('rim','共用轮廓线',{auto:'随材质',hairline:'细白线',classic:'原有边光',none:'关闭'},'auto'),
      number('rim width','轮廓线宽',0,3,.01,.42,'pt'),
      number('rim opacity','轮廓线浓度',0,1,.01,.74),
      color('rim color','轮廓线颜色','white'),
      number('sheen','柔光强度',0,1,.01,0),
      number('sheen size','柔光范围',.05,2,.01,.75),
      number('sheen x','光源位置 X',0,1,.01,.35),
      number('sheen y','光源位置 Y',0,1,.01,.22),
      number('highlight rolloff','亮部压缩',0,1,.01,0),
      number('edge','顶部高光',0,1,.01,.7),
      number('edge bottom','底缘高光',0,1,.01,.24),
      number('edge left','左缘高光',0,1,.01,.23),
      number('edge right','右缘暗线',0,1,.01,.13),
      number('edge width','边缘线宽',0,3,.01,.65,'pt'),
      color('edge color','高光色','white'), color('edge shade color','右缘色','LGShadow')
    ]},
    { id:'shadow', label:'阴影', fields:[
      choice('shadow profile','衰减曲线',{classic:'经典',smooth:'平滑',contour:'轮廓渐变'},'classic'),
      number('shadow','悬浮阴影强度',0,1,.001,.12),
      number('shadow blur','悬浮扩散',0,10,.05,2,'mm'),
      number('shadow xshift','悬浮横移',-10,10,.05,0,'mm'),
      number('shadow yshift','悬浮纵移',-10,10,.05,-.65,'mm'),
      number('shadow spread','悬浮扩张',-2,5,.05,0,'mm'),
      color('shadow color','阴影颜色','LGShadow'),
      number('shadow steps','衰减层数',4,64,1,24),
      number('contact opacity','接触阴影强度',0,1,.001,0),
      number('contact blur','接触扩散',0,10,.05,.6,'mm'),
      flag('contact follows shadow','接触层跟随横移'),
      number('contact xshift','接触横移',-10,10,.05,0,'mm'),
      number('contact yshift','接触纵移',-10,10,.05,-.3,'mm'),
      number('contact spread','接触扩张',-2,5,.05,0,'mm')
    ]},
    { id:'shape', label:'形状与底图', fields:[
      choice('image fit','底图适配',{cover:'等比填充',stretch:'拉伸'},'cover'),
      number('focus x','底图取景 X',0,1,.01,.5),
      number('focus y','底图取景 Y',0,1,.01,.5)
    ]},
    { id:'title', label:'标题与定理', fields:[
      flag('glass tab','玻璃标题签'), flag('theorem ribbon','原生定理飘带'),
      color('theorem accent','飘带强调色','LGRibbonGreen'),
      choice('theorem language','定理标签语言',{en:'English',zh:'中文'},'en'),
      flag('theorem measure title','按标题宽度调整留白')
    ]}
  ];
  const fields = sections.flatMap(section=>section.fields);
  const baseline = Object.fromEntries(fields.map(field=>[field.key,field.value]));
  const shiny = { mask:0,sheen:0,'highlight rolloff':0,'sheen size':.75,'sheen x':.35,'sheen y':.22 };
  const frosted = {...shiny,blur:2.4,opacity:.3,grain:.012,refraction:.35,saturation:1.08,contrast:7,'image fit':'cover'};
  const reference = {...shiny,blur:0,opacity:0,grain:0,refraction:0,saturation:1,contrast:7,'image fit':'stretch'};
  const reading = {...reference,blur:.55,refraction:.1,saturation:.89,mask:.17,sheen:.14,'sheen size':.72,'sheen x':.26,'sheen y':.32,contrast:8};
  const materialSets = {
    reading, 'reading-lens': reading, 'reading-window': {...reading,blur:.48,mask:.15},
    regular: {...frosted,grain:.004,saturation:.92,mask:.16,sheen:.08},
    clear: {...frosted,blur:.8,opacity:.12,grain:.005,refraction:.7,contrast:4.5},
    opaque: {...frosted,blur:0,grain:0,refraction:0,opacity:1},
    reference, frosted,
    luminous: {blur:2.4,opacity:.18,grain:.004,refraction:.35,saturation:.7,contrast:7,sheen:.55,
      'sheen size':.55,'sheen x':.45,'sheen y':.30,edge:.35,'edge bottom':.1,'edge left':.12,'edge right':.06,'edge width':.5}
  };
  const lifts = {
    none:{shadow:0,'shadow yshift':-.65,'contact opacity':0},
    soft:{shadow:.12,'shadow yshift':-.65,'contact opacity':0},
    raised:{shadow:.18,'shadow blur':3,'shadow yshift':-.8,'shadow steps':32,'contact opacity':0},
    air:{shadow:.12,'shadow blur':5,'shadow yshift':-.9,'shadow spread':.1,'shadow steps':40,'contact opacity':.035,
      'contact blur':.65,'contact yshift':-.3},
    cloud:{shadow:.1,'shadow profile':'smooth','shadow blur':6.2,'shadow yshift':-1.05,'shadow spread':-.35,'shadow steps':40,
      'contact opacity':.019,'contact blur':1.35,'contact yshift':-.26},
    quiet:{shadow:.075,'shadow profile':'smooth','shadow blur':3.25,'shadow yshift':-.85,'shadow spread':-.12,'shadow steps':40,
      'contact opacity':.021,'contact blur':.78,'contact yshift':-.22},
    float:{shadow:.052,'shadow profile':'contour','shadow blur':3.4,'shadow xshift':.20,'shadow yshift':-.65,
      'shadow spread':-.32,'shadow steps':40,'contact opacity':.026,'contact blur':.61,'contact xshift':.07,
      'contact yshift':-.24,'contact spread':-.12}
  };
  const radiusKeys = ['default','north','south','west','east','northwest','northeast','southwest','southeast'];
  const formal = (theme = 'light') => ({
    material:'reading-window', lift:'float', values:{theme}, radii:{default:3}, image:{mode:'reading',path:''}
  });
  const initial = () => formal();
  const colorValues = {
    white:[255,255,255],black:[0,0,0],gray:[128,128,128],red:[255,0,0],green:[0,128,0],blue:[0,0,255],
    cyan:[0,255,255],teal:[0,128,128],brown:[191,128,64],yellow:[255,255,0],orange:[255,128,0],
    violet:[128,0,128],purple:[191,0,64],magenta:[255,0,255],lime:[191,255,0],olive:[128,128,0],
    pink:[255,191,191],lightgray:[191,191,191],darkgray:[64,64,64],
    LGInk:[20,38,56],LGPaper:[244,248,255],LGShadow:[20,42,66],LGRibbonGreen:[66,102,102],
    LGRibbonIndigo:[6,82,121],LGRibbonRose:[203,58,86],LGRibbonTea:[179,92,68],LGRibbonWine:[140,67,86]
  };
  const labels = {'reading-window':'正式版玻璃','reading-lens':'银蓝悬浮',reading:'原银蓝阅读',regular:'柔雾',clear:'清透',opaque:'实色',reference:'原图',frosted:'磨砂',luminous:'柔光',default:'默认'};
  const liftLabels = { none:'无阴影',soft:'柔影',raised:'抬升',air:'悬浮',cloud:'云影',quiet:'轻薄悬浮',float:'悬浮玻璃' };
  const imageLabels = { reading:'按主题使用正式底图',page:'页面采样',silver:'银蓝底图',default:'默认底图',file:'项目文件',folder:'项目文件夹',list:'循环列表' };
  const isColor = value => typeof value === 'string' && /^[A-Za-z][\w-]*(?:!\d{1,3}(?:\.\d+)?(?:![A-Za-z][\w-]*)?)*$/.test(value);
  function rgb(expression,fallback='white') {
    const parts = expression.split('!');
    let result = colorValues[parts[0]];
    if (!result) return colorValues[fallback] ?? colorValues.white;
    for (let i=1;i<parts.length;i+=2) {
      const n = Math.max(0,Math.min(100,Number(parts[i])))/100;
      const other = colorValues[parts[i+1] ?? 'white'] ?? colorValues[fallback] ?? colorValues.white;
      result = result.map((value,k)=>Math.round(value*n+other[k]*(1-n)));
    }
    return result;
  }

  function settings(input) {
    const output = initial();
    if (Object.hasOwn(labels,input?.material ?? '')) output.material = input.material;
    output.values = {};
    output.radii = {};
    if (Object.hasOwn(lifts,input?.lift ?? '')) output.lift = input.lift;
    else if (output.material!=='reading-lens' && output.material!=='reading-window') output.lift = output.material==='reading'?'cloud':'soft';
    if (Object.hasOwn(imageLabels,input?.image?.mode ?? '')) output.image.mode = input.image.mode;
    if (typeof input?.image?.path === 'string') output.image.path = input.image.path.trim().slice(0,600);
    for (const field of fields) {
      const val = input?.values?.[field.key];
      if ((field.type === 'number' && Number.isFinite(val) && val>=field.min && val<=field.max &&
             (field.key !== 'shadow steps' || Number.isInteger(val))) ||
          (field.type === 'choice' && Object.hasOwn(field.values,val ?? '')) ||
          (field.type === 'flag' && val === true) || (field.type === 'color' && isColor(val))) {
        output.values[field.key] = val;
      }
    }
    for (const key of radiusKeys) {
      const val = input?.radii?.[key];
      if (Number.isFinite(val) && val>=0 && val<=100) output.radii[key] = val;
    }
    return output;
  }

  function resolved(input) {
    const window = input.material==='reading-window';
    const darkWindow = window && input.values.theme==='dark' && input.values.renderer!=='legacy';
    const windowTheme = window ? { opacity: darkWindow ? .07 : 0, contrast: darkWindow ? 4.5 : 8 } : {};
    const values = {...baseline,...materialSets[input.material],...windowTheme,...lifts[input.lift],...input.values};
    values.frost = darkWindow;
    values['contact follows shadow'] = !Object.hasOwn(input.values,'contact xshift') &&
      (input.values['contact follows shadow'] || !Object.hasOwn(lifts[input.lift] ?? {},'contact xshift'));
    const windowRim = window && values.rim==='auto';
    const directional = input.material==='reading-lens' && values.rim==='auto';
    if ((directional || windowRim) && !Object.hasOwn(input.values,'rim width')) values['rim width']=.70;
    if (!Object.hasOwn(input.values,'rim opacity')) {
      values['rim opacity']=windowRim ? (darkWindow ? .30 : .74) : directional ? (values.theme==='dark' ? .27 : .72) : (values.theme==='dark' ? .30 : .74);
    }
    return values;
  }

  function corners(radii) {
    return ['northwest','northeast','southeast','southwest'].map(corner => radii[corner] ??
      radii[corner.endsWith('west') ? 'west' : 'east'] ??
      radii[corner.startsWith('north') ? 'north' : 'south'] ?? radii.default ?? 4);
  }

  function imageToken(image) {
    if (['reading','page','silver','default'].includes(image.mode)) return '@'+image.mode;
    if (!image.path || /[\\{}%#|\r\n]/.test(image.path)) return '';
    return image.mode==='folder' ? '@folder:'+image.path : image.mode==='list' ? '@list:'+image.path : image.path;
  }

  function style(input, mode='options', styleName='studio glass') {
    input = settings(input);
    const entries = [];
    if (input.values['theorem ribbon']) entries.push('lg theorem ribbon');
    if (input.material==='luminous' || input.material==='frosted') entries.push('lg '+input.material);
    else if (input.material!=='default') entries.push('lg material='+input.material);
    entries.push('lg lift='+input.lift);
    const token = imageToken(input.image);
    if (token) entries.push('lg image={'+token+'}');
    for (const {key,type,unit} of fields) {
      if (key==='theorem ribbon' || !Object.hasOwn(input.values,key)) continue;
      if (type==='flag') {
        if (key==='contact follows shadow' && Object.hasOwn(input.values,'contact xshift')) continue;
        entries.push(key==='glass tab' ? key : 'lg '+key);
      } else {
        const value = input.values[key];
        entries.push('lg '+key+'='+value+(['blur','refraction'].includes(key) ? '' : (unit||'')));
      }
    }
    const radii = radiusKeys.filter(key=>Object.hasOwn(input.radii,key)).map(key=>key+'='+input.radii[key]+'mm');
    if (radii.length) entries.push('lg radius={'+radii.join(', ')+'}');
    if (mode==='global') return '\\glasssetup{\n  '+entries.join(',\n  ')+'\n}';
    if (mode==='named') {
      const name = /^[\w][\w -]{0,55}$/.test(styleName) ? styleName.trim() : 'studio glass';
      return '\\tcbset{'+name+'/.style={\n  liquid glass,\n  '+entries.join(',\n  ')+'\n}}';
    }
    return entries.join(',\n');
  }

  return { sections, labels, liftLabels, imageLabels, radiusKeys, initial, formal, settings, resolved, corners, rgb, imageToken, style };
});
