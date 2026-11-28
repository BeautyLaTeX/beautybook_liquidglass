/* A rounded signed-distance field drives the glass normals and edge lighting. */
globalThis.createGlassRenderer = canvas => {
  const ctx = canvas.getContext('2d');
  const background = document.createElement('canvas');
  const blurred = document.createElement('canvas');
  const w = background.width = blurred.width = canvas.width;
  const h = background.height = blurred.height = canvas.height;
  const base = background.getContext('2d',{willReadFrequently:true});
  const soft = blurred.getContext('2d',{willReadFrequently:true});
  let original, smoothed, previousBlur, pending, currentScene;
  const scene = new Image();
  scene.addEventListener('load',() => {
    base.drawImage(scene,0,0,w,h);
    original = base.getImageData(0,0,w,h);
    previousBlur = undefined;
    if (pending) draw(pending);
  });
  function setScene(path) {
    const url = path || canvas.dataset.scene;
    if (currentScene === url) return;
    currentScene = url;
    scene.src = url;
  }
  setScene();
  const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
  function draw(values) {
    pending = values;
    if (!original) return;
    const get = key => values['lg '+key];
    const blur = get('blur') * 1.6;
    if (blur !== previousBlur) {
      soft.clearRect(0,0,w,h);
      soft.fillStyle = '#6d7eb2';
      soft.fillRect(0,0,w,h);
      soft.filter = blur ? 'blur(' + blur + 'px)' : 'none';
      soft.drawImage(background,0,0,w,h);
      smoothed = soft.getImageData(0,0,w,h).data;
      previousBlur = blur;
    }
    const frame = new ImageData(new Uint8ClampedArray(original.data),w,h);
    const dest = frame.data;
    const cx = w/2, cy = h*.56, hw = w*.38, hh = h*.15, radius = 22;
    const refraction = get('refraction'), opacity = get('opacity'), edge = get('edge'), beauty = get('sheen');
    const shineX = cx - hw + 2*hw*get('sheen x'), shineY = cy - hh + 2*hh*get('sheen y');
    const shadow = get('shadow');
    for (let y = Math.max(0,Math.floor(cy-hh-23)); y < Math.min(h,cy+hh+48); y++) {
      for (let x = Math.max(0,Math.floor(cx-hw-30)); x < Math.min(w,cx+hw+30); x++) {
        const px = x - cx, py = y - cy;
        const qx = Math.abs(px) - hw + radius, qy = Math.abs(py) - hh + radius;
        const ax = Math.max(qx,0), ay = Math.max(qy,0);
        const length = Math.sqrt(ax*ax+ay*ay);
        const d = length + Math.min(Math.max(qx,qy),0) - radius;
        const i = 4*(w*y+x);
        if (d >= .5) {
          const falloff = 1 - clamp((d - py*.16)/30,0,1);
          const a = 1 - shadow * falloff * falloff * clamp((py+hh)/(hh*1.5),0,1);
          dest[i] *= a; dest[i+1] *= a; dest[i+2] *= a;
          continue;
        }
        const nx = length ? ax / length * Math.sign(px) : qx > qy ? Math.sign(px) : 0;
        const ny = length ? ay / length * Math.sign(py) : qy >= qx ? Math.sign(py) : 0;
        const rim = 1 - clamp(-d / 26,0,1);
        const bend = refraction * (rim*rim*39+1.8);
        const sx = clamp(Math.round(x - nx*bend + px*.025*refraction),0,w-1);
        const sy = clamp(Math.round(y - ny*bend + py*.025*refraction),0,h-1);
        const j = 4*(sy*w+sx);
        const highlight = Math.max(0,-.48*nx-.85*ny);
        const dx = (x-shineX)/(hw*.78), dy = (y-shineY)/(hh*.83);
        const specular = Math.max(0,1 - .36*(dx*dx+dy*dy));
        const rimLight = highlight*(Math.max(0,1+d/4)*.70+rim*.16)*edge;
        const tint = clamp(.22 + opacity*.68 + rimLight + specular*specular*beauty*.31,0,1);
        const alpha = clamp(.5-d,0,1);
        const grain = (((x*79+y*197)^(x*y*29))%101-50)*.024;
        for (let k = 0; k < 3; k++) {
          const glass = smoothed[j+k]*(1-tint) + (245+k*4)*tint + grain;
          dest[i+k] = alpha*glass + (1-alpha)*dest[i+k];
        }
      }
    }
    ctx.putImageData(frame,0,0);
  }
  return { draw, setScene };
};
