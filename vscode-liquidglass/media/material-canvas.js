/* LiquidGlass optics in design coordinates. TeX supplies final page geometry. */
(() => {
  const M = globalThis.LiquidMaterial;
  const clamp = (v,a,b)=>Math.min(b,Math.max(a,v));
  const mix = (a,b,t)=>a+(b-a)*t;
  const color = (rgb,opacity=1)=>'rgba('+rgb.join(',')+','+opacity+')';
  const linear = Array.from({length:256},(_,i)=>i/255<=.04045 ? i/255/12.92 : ((i/255+.055)/1.055)**2.4);
  const luminance = (r,g,b)=>.2126*linear[r]+.7152*linear[g]+.0722*linear[b];
  const textLight = luminance(20,38,56), textDark = luminance(244,248,255);
  const maximum = { light:1.05/(textLight+.05), dark:(textDark+.05)/.05 };
  function round(box,radii) {
    const shape = new Path2D();
    shape.roundRect(box.x,box.y,Math.max(1,box.w),Math.max(1,box.h),radii.map(r=>Math.max(0,r)));
    return shape;
  }
  function openEdge(box,r,part,inset) {
    const left=box.x+inset, right=box.x+box.w-inset;
    const top=box.y+inset, bottom=box.y+box.h-inset;
    const [nw,ne,se,sw]=r.map(value=>Math.max(0,value-inset));
    if(part==='full') return round({x:left,y:top,w:right-left,h:bottom-top},[nw,ne,se,sw]);
    const path=new Path2D();
    if(part==='first') {
      path.moveTo(left,box.y+box.h);
      path.arcTo(left,top,right,top,nw);
      path.arcTo(right,top,right,box.y+box.h,ne);
      path.lineTo(right,box.y+box.h);
    } else if(part==='last') {
      path.moveTo(right,box.y);
      path.arcTo(right,bottom,left,bottom,se);
      path.arcTo(left,bottom,left,box.y,sw);
      path.lineTo(left,box.y);
    } else {
      path.moveTo(left,box.y); path.lineTo(left,box.y+box.h);
      path.moveTo(right,box.y); path.lineTo(right,box.y+box.h);
    }
    return path;
  }
  function imageRect(image,w,h,fit,fx,fy) {
    if (fit==='stretch') return [0,0,image.width,image.height];
    const scale = Math.max(w/image.width,h/image.height);
    const width = w/scale,height = h/scale;
    return [(image.width-width)*fx,(image.height-height)*fy,width,height];
  }
  function create(canvas) {
    const ctx=canvas.getContext('2d');
    const layer=document.createElement('canvas');
    const texture=document.createElement('canvas');
    const shadowCanvas=document.createElement('canvas');
    const src=texture.getContext('2d',{willReadFrequently:true});
    const out=layer.getContext('2d');
    const pad=74, w=canvas.width,h=canvas.height;
    shadowCanvas.width=w;shadowCanvas.height=h;
    const shadowMask=shadowCanvas.getContext('2d');
    const unit=4, box={x:Math.round(w*.14),y:Math.round(h*.26),w:Math.round(w*.72),h:Math.round(h*.48)};
    let lastPhoto,lastFit,sourceImage,lastFrame,lastBackdrop;
    const assets=new Map();
    const noise = Uint8Array.from({length:box.w*box.h},(_,n)=>{
      let z=(n+1)*0x45d9f3b|0; z=(z^(z>>>16))*0x45d9f3b|0; return (z^(z>>>16))&255;
    });
    layer.width=box.w; layer.height=box.h;
    texture.width=box.w+pad*2; texture.height=box.h+pad*2;

    function requestImage(url,onLoad) {
      if (!url) return undefined;
      if (assets.has(url)) return assets.get(url).image;
      if (assets.size>=8) assets.delete(assets.keys().next().value);
      const entry={};
      assets.set(url,entry);
      const image=new Image();
      image.onload=()=>{ entry.image=image; onLoad(); };
      image.onerror=()=>{ onLoad(); };
      image.src=url;
      return undefined;
    }
    function backdrop(image, stage) {
      ctx.fillStyle=stage==='paper'?'#f2f2f2':stage==='dark'?'#20323c':stage==='grid'?'#e8f0f2':'#ddd6c9';
      ctx.fillRect(0,0,w,h);
      if (image && !['paper','dark'].includes(stage)) {
        ctx.globalAlpha=stage==='dark'?.63:1;
        ctx.drawImage(image,...imageRect(image,w,h,'cover',.5,.5),0,0,w,h);
        ctx.globalAlpha=1;
      }
      if (stage==='grid') {
        ctx.strokeStyle='#56554e44';
        ctx.lineWidth=1;
        ctx.beginPath();
        for(let x=0;x<w;x+=25){ctx.moveTo(x,0);ctx.lineTo(x,h);}
        for(let y=0;y<h;y+=25){ctx.moveTo(0,y);ctx.lineTo(w,y);}
        ctx.stroke();
      }
    }
    function capture(image,v,input,stage) {
      const p=texture.width, q=texture.height;
      const fromPage=input.image.mode==='page'||!image;
      const frameKey=[fromPage, v.blur, v['image fit'], v['focus x'], v['focus y'],stage].join('|');
      if (frameKey===lastFit && image===lastPhoto && lastBackdrop===lastFrame && sourceImage) return sourceImage;
      lastFit=frameKey; lastPhoto=image; lastFrame=lastBackdrop;
      const raw=document.createElement('canvas');
      raw.width=p; raw.height=q;
      const paint=raw.getContext('2d');
      paint.fillStyle='#e5dfd5'; paint.fillRect(0,0,p,q);
      if (fromPage) {
        paint.drawImage(canvas,box.x-pad,box.y-pad,p,q,0,0,p,q);
      } else {
        const [x,y,iw,ih]=imageRect(image,box.w,box.h,v['image fit'],v['focus x'],v['focus y']);
        paint.drawImage(image,x,y,iw,ih,pad,pad,box.w,box.h);
        paint.drawImage(raw,pad,pad,1,box.h,0,pad,pad,box.h);
        paint.drawImage(raw,pad+box.w-1,pad,1,box.h,pad+box.w,pad,pad,box.h);
        paint.drawImage(raw,0,pad,p,1,0,0,p,pad);
        paint.drawImage(raw,0,pad+box.h-1,p,1,0,pad+box.h,p,pad);
      }
      src.fillStyle='#ddd7cb'; src.fillRect(0,0,p,q);
      src.filter=v.blur ? 'blur('+v.blur*unit+'px)' : 'none';
      src.drawImage(raw,0,0);
      src.filter='none';
      sourceImage=src.getImageData(0,0,p,q);
      return sourceImage;
    }
    function drawShadow(v,radii,shape,part) {
      function shadowLayer(opacity,blur,dx,dy,spread) {
        if (opacity<=0) return;
        const steps=v['shadow steps'];
        const contour=v['shadow profile']==='contour';
        const pigment=M.rgb(v['shadow color'],'LGShadow');
        const outline=t=>{
          const extend=Math.max(spread+blur*t,-Math.min(box.w,box.h)/2/unit+.05)*unit;
          return round({x:box.x+dx*unit-extend,y:box.y-dy*unit-extend,w:box.w+2*extend,h:box.h+2*extend},
                       radii.map(r=>contour&&r===0?0:r+extend));
        };
        if(contour)shadowMask.clearRect(0,0,w,h);
        for(let i=steps;i>0;i--){
          if(contour){
            const t=(i-.5)/steps, previous=Math.min(1,(i+.5)/steps);
            const alpha=1-(t/previous)**2*(3-2*t)/(3-2*previous);
            shadowMask.fillStyle=color(pigment,alpha);
            shadowMask.fill(outline(i/steps));
            continue;
          }
          const t=v['shadow profile']==='smooth'?(i-.5)/steps:i/steps;
          const strength=v['shadow profile']==='smooth'?1-(1-opacity)**(6*t*(1-t)/steps):
            Math.min(1,opacity*Math.exp(-3*t*t)/(steps*.49));
          ctx.fillStyle=color(pigment,strength);
          ctx.fill(outline(t));
        }
        if(contour){
          ctx.save();ctx.globalAlpha=opacity;ctx.drawImage(shadowCanvas,0,0);ctx.restore();
        }
      }
      const mask=new Path2D();
      const top=['middle','last'].includes(part)?box.y:0;
      const bottom=['first','middle'].includes(part)?box.y+box.h:h;
      mask.rect(0,top,w,bottom-top);
      mask.addPath(shape);
      ctx.save();ctx.clip(mask,'evenodd');
      shadowLayer(v.shadow,v['shadow blur'],v['shadow xshift'],v['shadow yshift'],v['shadow spread']);
      shadowLayer(v['contact opacity'],v['contact blur'],v['contact follows shadow']?v['shadow xshift']:v['contact xshift'],
        v['contact yshift'],v['contact spread']);
      ctx.restore();
    }
    function material(data,v,part,preset) {
      const image=out.createImageData(box.w,box.h);
      const bitmap=image.data, width=box.w,height=box.h;
      const refraction=(v.frost && v.prepared ? 0 : v.refraction)*unit, band=Math.max(2,refraction*4);
      const lens=preset==='reading-lens';
      const frost=v.frost && v.prepared;
      const frostInk=luminance(18,18,18);
      const edgeResponse=n=>lens?Math.max(0,1-n/(2*unit))**2:Math.exp(-n/band);
      const warpX=Array.from({length:width},(_,x)=>x+refraction*(edgeResponse(x)-(lens?0:edgeResponse(width-x))));
      const warpY=Array.from({length:height},(_,y)=>y+refraction*((part==='full'||part==='first'?edgeResponse(y):0)-
        (!lens&&(part==='full'||part==='last')?edgeResponse(height-y):0)));
      const dark=v.theme==='dark', tint=dark?[12,24,40]:[246,250,255], shine=dark?[100,137,158]:[255,255,255];
      const sigma=Math.max(1,v['sheen size']*Math.min(width,height));
      const fieldX=Array.from({length:width},(_,x)=>v.sheen*Math.exp(-.5*((x+.5-v['sheen x']*width)/sigma)**2));
      const fieldY=Array.from({length:height},(_,y)=>Math.exp(-.5*((y+.5-v['sheen y']*height)/sigma)**2));
      let weakest=Infinity, min=255,max=0;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
        const sx=clamp(pad+warpX[x],0,data.width-1), sy=clamp(pad+warpY[y],0,data.height-1);
        const ix=Math.floor(sx),iy=Math.floor(sy), fx=sx-ix,fy=sy-iy;
        const a=(iy*data.width+ix)*4,b=a+4,c=a+data.width*4,d=c+4;
        const sample=k=>mix(mix(data.data[a+k],data.data[b+k],fx),mix(data.data[c+k],data.data[d+k],fx),fy);
        const measured=[sample(0),sample(1),sample(2)], gray=.299*measured[0]+.587*measured[1]+.114*measured[2];
        const veil=(frost ? 0 : v.mask)*(.20+.55*(x+.5)/width+.25*(y+.5)/height);
        const i=(y*width+x)*4;
        for(let k=0;k<3;k++) {
          if (frost) {
            bitmap[i+k]=measured[k];
            continue;
          }
          let value=mix(gray,measured[k],v.saturation);
          value=mix(clamp(value,0,255),tint[k],v.opacity);
          value=mix(mix(value,tint[k],veil),shine[k],fieldX[x]*fieldY[y]);
          if(!dark) value-=v['highlight rolloff']*[55,48,43][k]*(Math.max(0,value-128)/127)**2;
          bitmap[i+k]=mix(value,noise[i/4],v.grain);
          min=Math.min(min,bitmap[i+k]);max=Math.max(max,bitmap[i+k]);
        }
        bitmap[i+3]=255;
        const l=luminance(bitmap[i],bitmap[i+1],bitmap[i+2]), t=frost?frostInk:dark?textDark:textLight;
        weakest=Math.min(weakest,(Math.max(l,t)+.05)/(Math.min(l,t)+.05));
      }
      const limitContrast=frost?1.05/(frostInk+.05):maximum[v.theme];
      const requested=Math.min(v.contrast,limitContrast);
      if (frost) {
        const limit=requested*(frostInk+.05)-.05;
        const encode=value=>255*(value<=.0031308?value*12.92:1.055*value**(1/2.4)-.055);
        weakest=Infinity;
        for (let i=0;i<bitmap.length;i+=4) {
          const value=luminance(bitmap[i],bitmap[i+1],bitmap[i+2]);
          if (value<limit) {
            const amount=clamp((limit+.002-value)/(1-value),0,1);
            for(let k=0;k<3;k++) bitmap[i+k]=encode(mix(linear[bitmap[i+k]],1,amount));
          }
          weakest=Math.min(weakest,(luminance(bitmap[i],bitmap[i+1],bitmap[i+2])+.05)/(frostInk+.05));
        }
      } else if(weakest<requested){
        const target=dark?(textDark+.05)/requested-.05:requested*(textLight+.05)-.05;
        let level=linear.findIndex(value=>value>=target);
        if(level<0)level=255;
        if(dark&&linear[level]>target)level=Math.max(0,level-1);
        const delta=dark?Math.max(0,1-level/Math.max(1,max)):Math.max(0,(level-min)/Math.max(1,255-min));
        weakest=Infinity;
        for(let i=0;i<bitmap.length;i+=4){
          for(let k=0;k<3;k++)bitmap[i+k]=dark?Math.floor(bitmap[i+k]*(1-delta)):Math.ceil(mix(bitmap[i+k],255,delta));
          const l=luminance(bitmap[i],bitmap[i+1],bitmap[i+2]), t=dark?textDark:textLight;
          weakest=Math.min(weakest,(Math.max(l,t)+.05)/(Math.min(l,t)+.05));
        }
      }
      out.putImageData(image,0,0);
      return {contrast:weakest,possible:v.contrast<=limitContrast};
    }
    function drawEdge(v,shape,r,part,material) {
      if (v.rim==='none') return;
      const directional=v.rim==='auto'&&material==='reading-lens';
      const windowRim=v.rim==='auto'&&material==='reading-window';
      if (v.rim==='hairline'||directional||windowRim) {
        const width=v['rim width']*unit*25.4/72.27;
        if (!width||(directional&&v.renderer==='legacy')) return;
        ctx.save();
        ctx.lineWidth=width; ctx.lineJoin='round'; ctx.lineCap='butt';
        const edge=openEdge(box,r,part,width*.5+.08*unit*25.4/72.27);
        const alpha=v['rim opacity'];
        if (directional) {
          const {x,y,w,h}=box;
          const white=v.theme==='dark'?[240,249,255]:[255,255,255];
          // The interactive preview is approximate. PDF uses optical normals.
          const main=ctx.createRadialGradient(x+w*.15,y-h*.03,0,x+w*.15,y-h*.03,w*.69);
          main.addColorStop(0,color(white,alpha));
          main.addColorStop(.58,color(white,alpha*.30));
          main.addColorStop(1,color(white,0));
          const bounce=ctx.createRadialGradient(x+w*.83,y+h,0,x+w*.83,y+h,w*.32);
          bounce.addColorStop(0,color(white,alpha*.065));
          bounce.addColorStop(1,color(white,0));
          ctx.strokeStyle=main;ctx.stroke(edge);
          ctx.strokeStyle=bounce;ctx.stroke(edge);
        } else {
          if (windowRim && !v.frost) {
            ctx.strokeStyle=color([172,179,190],.36);
            ctx.lineWidth=.4*unit*25.4/72.27;ctx.stroke(openEdge(box,r,part,.12*unit*25.4/72.27));
            ctx.lineWidth=width;
          }
          ctx.strokeStyle=color(M.rgb(v['rim color']),alpha);ctx.stroke(edge);
        }
        ctx.restore();
        return;
      }
      const width=v['edge width']*unit*25.4/72.27;
      if (!width) return;
      const edge=M.rgb(v['edge color']), shade=M.rgb(v['edge shade color'],'LGShadow');
      ctx.save(); ctx.clip(shape);
      ctx.strokeStyle=color(edge,v['edge bottom']);ctx.lineWidth=width*.69;ctx.stroke(openEdge(box,r,part,0));
      function bar(x1,y1,x2,y2,rgb,alpha,scale) {
        ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);
        ctx.lineCap='round';ctx.lineWidth=width*scale;ctx.strokeStyle=color(rgb,alpha);ctx.stroke();
      }
      const {x,y,w,h}=box, n=.7;
      if(part==='full'||part==='first')bar(x+r[0],y+n,x+w-r[1],y+n,edge,v.edge,1);
      if(part==='full'||part==='last')bar(x+r[3],y+h-n,x+w-r[2],y+h-n,edge,v['edge bottom'],.54);
      bar(x+n,y+r[0],x+n,y+h-r[3],edge,v['edge left'],.69);
      bar(x+w-n,y+r[1],x+w-n,y+h-r[2],shade,v['edge right'],.54);
      ctx.restore();
    }
    return {
      box,
      draw(input,ui,onLoad) {
        const image=requestImage(ui.image,onLoad);
        const scene=requestImage(canvas.dataset.scene,onLoad);
        const prepared=Boolean(image && input.image.mode==='reading' && input.material==='reading-window');
        const displayed=prepared?scene:image||scene;
        if(lastBackdrop!==displayed){lastBackdrop=displayed;lastFit=undefined;}
        backdrop(displayed,ui.stage);
        if(ui.baseOnly) return;
        const v={...M.resolved(input),prepared};
        const data=capture(image,prepared && v.frost ? {...v,blur:0,'image fit':'stretch'} : v,input,ui.stage);
        const shapeRadius=M.corners(input.radii).map(radius=>Math.min(radius*unit,box.w/2,box.h/2));
        if(['middle','last'].includes(ui.part))shapeRadius[0]=shapeRadius[1]=0;
        if(['middle','first'].includes(ui.part))shapeRadius[2]=shapeRadius[3]=0;
        const shape=round(box,shapeRadius);
        drawShadow(v,shapeRadius,shape,ui.part);
        const result=material(data,v,ui.part,input.material);
        ctx.save(); ctx.clip(shape); ctx.drawImage(layer,box.x,box.y); ctx.restore();
        drawEdge(v,shape,shapeRadius,ui.part,input.material);
        return result;
      }
    };
  }
  globalThis.createMaterialCanvas=create;
})();
