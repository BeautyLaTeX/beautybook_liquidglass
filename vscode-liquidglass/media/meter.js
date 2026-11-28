/* The torus is lit from its surface normals. Cached textures make movement inexpensive. */
globalThis.mountLiquidGlassMeter = () => {
  const gauge = document.getElementById('gauge');
  const canvas = document.getElementById('dial');
  const number = document.getElementById('percent');
  const context = canvas.getContext('2d');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const turn = Math.PI * 2;
  const start = -Math.PI / 2;
  const inner = 74, outer = 137;
  const middle = (inner + outer) / 2, thickness = (outer - inner) / 2;
  const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
  const mix = (a,b,t) => a+(b-a)*t;
  const tones = {
    green: [[10,83,59],[38,172,108],[172,241,169]],
    error: [[115,47,42],[194,83,66],[249,183,158]],
    stopped: [[66,82,80],[109,139,132],[200,217,204]]
  };
  const grains = Array.from({length:42},(_,index)=>({
    angle: index*2.399963, depth: ((index*13)%41)/40,
    radius: .65+(index%7)*.22, speed: .038+(index%5)*.027
  }));

  let target = 0, displayed = 0, phase = 'idle', running = false;
  let frame, transition, cached, lastPaint = 0;

  function disc(ctx,radius,fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(0,0,radius,0,turn);
    ctx.fill();
  }

  function surface(size,dark,tone) {
    const image = new ImageData(size,size);
    const half = size/2, units = half/160;
    const edge = .85/units;
    const data = image.data;
    for(let y=0;y<size;y++){
      const py = (y+.5-half)/units;
      for(let x=0;x<size;x++){
        const px = (x+.5-half)/units;
        const r = Math.sqrt(px*px + py*py);
        if(r<inner-edge || r>outer+edge)continue;
        const offset = clamp((r-middle)/thickness,-1,1);
        const alongX = px/r, alongY = py/r;
        const nz = Math.sqrt(1-offset*offset);
        const diffuse = clamp((-.41*alongX-.51*alongY)*offset+.76*nz);
        const reflection = clamp((-.27*alongX-.40*alongY)*offset+.86*nz);
        const glint = reflection**32 * (.38+.62*clamp(.5-.42*alongX-.43*alongY));
        const fresnel = (1-nz)**2;
        const rim = Math.exp(-((Math.abs(offset)-.91)**2)/.004);
        const i = 4*(y*size+x);
        if(tone){
          const [shade,body,light] = tone;
          const fill = clamp(.21+.72*diffuse + .14*nz + .075*(1-alongY));
          const sheen = clamp(glint*.66 + rim*.30*(.38+.62*Math.max(0,-alongY)) + fresnel*.10);
          for(let c=0;c<3;c++)data[i+c] = mix(mix(shade[c],body[c],fill),light[c],sheen);
        } else {
          const shade = dark?[24,48,43]:[181,194,183];
          const body = dark?[98,129,116]:[246,247,237];
          const sheen = clamp(glint*.42 + rim*.25*(.34+.66*Math.max(0,-alongY)));
          for(let c=0;c<3;c++)data[i+c] = mix(mix(shade[c],body[c],.28+.62*diffuse),dark?201:255,sheen);
        }
        const coverage = clamp((outer-r)/edge+.5)*clamp((r-inner)/edge+.5);
        data[i+3] = Math.round(coverage*255);
      }
    }
    const texture = document.createElement('canvas');
    texture.width = texture.height = size;
    texture.getContext('2d').putImageData(image,0,0);
    return texture;
  }

  function createScene(size,dark) {
    const scene = document.createElement('canvas');
    scene.width = scene.height = size;
    const ctx = scene.getContext('2d');
    const unit = size/320;
    ctx.setTransform(unit,0,0,unit,size/2,size/2);

    const ambient = ctx.createRadialGradient(0,9,63,0,10,148);
    ambient.addColorStop(0,'transparent');
    ambient.addColorStop(.72,dark?'#020e0d75':'#315b3d32');
    ambient.addColorStop(1,'transparent');
    ctx.fillStyle = ambient;
    ctx.fillRect(-160,-160,320,320);

    ctx.save();
    ctx.shadowBlur = 18*unit;
    ctx.shadowOffsetY = 7*unit;
    ctx.shadowColor = dark?'#001b14cc':'#26463642';
    const ring = new Path2D();
    ring.arc(0,0,outer-1,0,turn);
    ring.moveTo(inner,0);
    ring.arc(0,0,inner,0,turn);
    ctx.fillStyle = dark?'#5a796b':'#ccdbcd';
    ctx.fill(ring,'evenodd');
    ctx.restore();

    ctx.drawImage(surface(size,dark),-160,-160,320,320);

    ctx.save();
    ctx.shadowBlur = 10*unit;
    ctx.shadowOffsetY = 4*unit;
    ctx.shadowColor = dark?'#041812b0':'#415e4449';
    const hub = ctx.createLinearGradient(-48,-63,36,68);
    hub.addColorStop(0,dark?'#416257':'#fffffb');
    hub.addColorStop(.52,dark?'#243d35':'#f1f6ed');
    hub.addColorStop(1,dark?'#1d302b':'#dfeadf');
    disc(ctx,inner-2,hub);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(0,0,inner-2.5,0,turn);
    ctx.strokeStyle = dark?'#b8d9c371':'#ffffffd8';
    ctx.lineWidth = .8;
    ctx.stroke();

    return {scene,dark,size,unit,textures:new Map()};
  }

  function sector(progress,bend) {
    const end = start + progress*turn;
    const b = end - Math.min(progress*.8,.032);
    const a = end + Math.min(progress*.4,.024);
    const point = (radius,angle) => [Math.cos(angle)*radius,Math.sin(angle)*radius];
    const shape = new Path2D();
    shape.moveTo(0,0);
    shape.lineTo(...point(outer+4,start));
    shape.arc(0,0,outer+4,start,end);
    shape.bezierCurveTo(...point(outer-8,b),...point(middle,a+bend),...point(inner-2,end));
    shape.closePath();
    return shape;
  }

  function droplets(ctx,seconds,filled) {
    for (const grain of grains) {
      const angle = grain.angle+seconds*grain.speed;
      const radius = inner+7+grain.depth*(outer-inner-14)+2*Math.sin(angle*3+seconds*.61);
      const x = Math.cos(angle)*radius, y = Math.sin(angle)*radius;
      const opacity = .56+.44*Math.sin(grain.angle*3+seconds*.85);
      ctx.globalAlpha = filled ? .28+.47*opacity : .22+.20*opacity;
      ctx.beginPath();
      ctx.arc(x,y,grain.radius,0,turn);
      ctx.fillStyle = filled ? '#edffdc' : cached.dark ? '#b5d4bc' : '#658c76';
      ctx.fill();
      if(filled && grain.radius>1.35) {
        ctx.strokeStyle = '#e8ffdb';
        ctx.lineWidth = .58;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function meniscus(ctx,progress,bend) {
    if(progress<.017||progress>.995) return;
    const angle=start+progress*turn;
    const x=Math.cos(angle)*middle, y=Math.sin(angle)*middle;
    const glow=ctx.createRadialGradient(x,y,0,x,y,29);
    glow.addColorStop(0,'#d5ffd79b');
    glow.addColorStop(1,'transparent');
    ctx.fillStyle=glow;
    ctx.beginPath();
    ctx.arc(x,y,29,0,turn);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle-.019)*outer,Math.sin(angle-.019)*outer);
    ctx.quadraticCurveTo(Math.cos(angle+.064+bend)*middle,Math.sin(angle+.064+bend)*middle,
      Math.cos(angle-.018)*inner,Math.sin(angle-.018)*inner);
    ctx.lineWidth=.95;
    ctx.strokeStyle='#e7ffdf9c';
    ctx.stroke();
  }

  function schedule() {
    if(frame===undefined&&!document.hidden)frame=requestAnimationFrame(draw);
  }

  function draw(time) {
    frame=undefined;
    if(document.hidden)return;
    if(running && !reduceMotion.matches && lastPaint && time-lastPaint<24){
      schedule();
      return;
    }
    lastPaint=time;
    let rebound=0;
    if(transition){
      const t=clamp((time-transition.start)/transition.duration);
      displayed=mix(transition.from,target,1-(1-t)**3);
      rebound=Math.sin(t*Math.PI*4)*(1-t)*.035;
      if(t>=1)transition=undefined;
    }
    if(context && canvas.clientWidth) {
      const size=Math.round(canvas.clientWidth*Math.min(devicePixelRatio||1,2.25));
      const dark=document.body.matches('.vscode-dark,.vscode-high-contrast');
      if(cached?.size!==size||cached?.dark!==dark){
        canvas.width=canvas.height=size;
        cached=createScene(size,dark);
      }
      const {unit,scene,textures}=cached;
      context.setTransform(1,0,0,1,0,0);
      context.clearRect(0,0,size,size);
      context.drawImage(scene,0,0);
      context.setTransform(unit,0,0,unit,size/2,size/2);
      const seconds=running&&!reduceMotion.matches?time/1000:0;
      droplets(context,seconds*.34,false);
      if(displayed>0){
        const progress=displayed/100;
        const palette=phase==='error'?'error':phase==='canceled'?'stopped':'green';
        if(!textures.has(palette))textures.set(palette,surface(size,dark,tones[palette]));
        const bend=(running&&!reduceMotion.matches?Math.sin(seconds*2.5)*.022:0)+rebound;
        context.save();
        if(progress<1)context.clip(sector(progress,bend));
        context.drawImage(textures.get(palette),-160,-160,320,320);
        meniscus(context,progress,bend);
        droplets(context,seconds,true);
        context.restore();
      }
    }
    if((running&&!reduceMotion.matches)||transition)schedule();
  }

  new ResizeObserver(schedule).observe(gauge);
  new MutationObserver(schedule).observe(document.body,{attributes:true,attributeFilter:['class']});
  reduceMotion.addEventListener('change',()=>{
    if(reduceMotion.matches){transition=undefined;displayed=target;}
    schedule();
  });
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden&&frame!==undefined){cancelAnimationFrame(frame);frame=undefined;}
    else schedule();
  });
  schedule();

  return data=>{
    phase=data.phase;
    running=data.busy&&!data.ended&&!['done','error','canceled'].includes(phase);
    const value=clamp(Math.round(data.progress||0),0,100);
    if(value!==target){
      target=value;
      if(reduceMotion.matches || (target<=3&&['inspect','idle'].includes(phase))){
        displayed=target;
        transition=undefined;
      } else transition={from:displayed,start:performance.now(),duration:target===100?620:450};
    }
    gauge.setAttribute('aria-valuenow',String(target));
    number.textContent=String(target);
    schedule();
  };
};
