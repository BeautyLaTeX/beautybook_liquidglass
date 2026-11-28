globalThis.bindLiquidGlassFontScale = vscode => {
  const control = document.querySelector('[data-font-scale]');
  if (!control) return;
  const choices = Array.from({length:21},(_,index)=>100+index*5);
  function apply(percent) {
    if (!Number.isInteger(percent) || percent < 100 || percent > 200) return;
    if (![...control.options].some(option=>Number(option.value)===percent)) {
      const sizes = [...new Set([...choices,percent])].sort((a,b)=>a-b);
      control.replaceChildren(...sizes.map(size=>new Option(size+'%',String(size))));
    }
    control.value = String(percent);
    document.documentElement.style.setProperty('--lg-font-scale',String(percent/100));
  }

  apply(Number(document.body.dataset.initialFontScale) || 125);
  control.addEventListener('change',()=>{
    const percent = Number(control.value);
    apply(percent);
    vscode.postMessage({action:'setFontScale',percent});
  });
  window.addEventListener('message',({data})=>{
    if (data.type==='fontScale') apply(data.percent);
  });
  vscode.postMessage({action:'getFontScale'});
};
