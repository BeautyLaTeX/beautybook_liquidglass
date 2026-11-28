const fs = require('node:fs/promises');
const { COPYFILE_FICLONE } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { mask, environments, knownGlass } = require('./source');

function preamble(text) {
  const source = mask(text);
  const opener = /\\begin\s*\{document\}/.exec(source);
  const type = /\\documentclass\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/.exec(source);
  return opener && type && type.index < opener.index && type[1] !== 'subfiles' ? text.slice(0, opener.index) : '';
}

function bodyContext(text, offset) {
  const prefix = mask(text.slice(0,offset));
  const body = /\\begin\s*\{document\}/.exec(prefix);
  if (!body) return '';
  const code = prefix.slice(body.index + body[0].length);
  const switches = [...code.matchAll(/(?<!\\)\\(frontmatter|mainmatter|backmatter|BeautyGlassOn|BeautyGlassOff)\b/g)];
  const matter = switches.findLast(item => /matter$/.test(item[1]));
  const glass = switches.findLast(item => item.index > (matter?.index ?? -1) && item[1].startsWith('BeautyGlass'));
  return [matter?.[0],glass?.[0]].filter(Boolean).join('\n');
}

function wrapper(fragment, inherited = '', demo = false, forceGlass = false, body = '') {
  const code = mask(fragment);
  const envs = environments(fragment);
  const has = pattern => envs.some(item => pattern.test(item.name));
  const glass = demo || forceGlass || has(knownGlass) || /(?:liquid glass|lg\s+(?:blur|material|refraction|luminous|image))/i.test(code);
  if (has(/^document$/) && preamble(fragment)) return { text:fragment,lineOffset:0,glass };
  const plot = has(/^(?:axis|semilog[xy]axis|loglogaxis)$/) || /\\addplot\b/.test(code);
  const picture = has(/^(?:tikzpicture|pgfpicture)$/);
  const tikz = picture || plot || has(/^scope$/) || /\\(?:tikz|draw|path|fill|filldraw|coordinate|node|clip|foreach)\b/.test(code);
  const tcb = glass || has(/^(?:tcolorbox|tcblisting)$/);
  const packages = [];
  if (tikz) packages.push('tikz');
  if (plot) packages.push('pgfplots');
  if (tcb) packages.push('tcolorbox');
  if (glass) packages.push('liquidglass');
  if (/\\includegraphics\b/.test(code)) packages.push('graphicx');
  if (/\\(?:frac|dfrac|tfrac|text|sqrt|begin\s*\{(?:align|gather|multline|equation|cases|aligned|[pbvBV]?matrix)\*?\})\b/.test(code) ||
      has(/^(?:align|gather|multline|equation|cases|aligned|gathered|split|[pbvBV]?matrix)\*?$/)) packages.push('amsmath');
  if (/\\(?:mathbb|mathfrak)\b/.test(code)) packages.push('amssymb');
  const additions = packages.map(name => '\\@ifpackageloaded{' + name + '}{}{\\usepackage{' + name + '}}');
  const libs = [];
  if (/Stealth|Latex|Triangle/.test(code)) libs.push('arrows.meta');
  if (/\b(?:above|below|left|right)(?:\s+left|\s+right)?\s*=\s*(?:[\d.]+\s*(?:cm|mm|pt)\s+)?of\s/.test(code)) libs.push('positioning');
  if (/\(\$/.test(code)) libs.push('calc');
  if (tikz && libs.length) additions.push('\\usetikzlibrary{' + libs.join(',') + '}');
  if (tcb) additions.push('\\tcbuselibrary{skins,breakable' + (has(/^tcblisting$/) ? ',listings' : '') + '}');
  if (plot && !inherited) additions.push('\\pgfplotsset{compat=1.18}');
  if (demo) additions.push('\\usepackage[paperwidth=132mm,paperheight=76mm,margin=16mm]{geometry}',
    '\\glasspagebackground{lab-scene.png}');
  let start = '', end = '';
  if (tikz && !picture && !/\\tikz\b/.test(code)) {
    start = '\\begin{tikzpicture}';
    end = '\\end{tikzpicture}';
    if (/^\s*\\addplot\b/.test(code)) { start += '\n\\begin{axis}'; end = '\\end{axis}\n' + end; }
  } else if (!tikz && !tcb && !/\$|\\\(|\\\[/.test(code) && !has(/^(?:align|gather|multline|equation|displaymath|math)\*?$/) &&
      (/^\s*\\(?:frac|dfrac|tfrac|sqrt|sum|int|lim|overset|underbrace|begin\s*\{(?:cases|aligned|[pbvBV]?matrix))\b/.test(code) ||
        /^[\w\d\s()+.,=^_{}-]+$/.test(code) && /[_^]/.test(code))) {
    start = '\\['; end = '\\]';
  }
  // A tight page is useful for pictures and formulas. Use the original page
  // geometry for boxes with page-dependent backgrounds, floats and page breaks.
  const box = tcb && !glass && !inherited && !/\bbreakable\b/.test(code);
  const tight = !glass && (box || tikz && !tcb || start === '\\[' || /^\s*(?:\$|\\[[(])/.test(code) || has(/^(?:equation|align|gather|multline|math|displaymath)\*?$/));
  const head = [inherited || '\\documentclass{article}', '\\makeatletter', ...additions, '\\makeatother',
    ...(tight ? ['\\usepackage[active,tightpage]{preview}', '\\setlength\\PreviewBorder{9pt}'] : []),
    '\\begin{document}', body, '\\pagestyle{empty}', ...(demo ? ['\\vspace*{7mm}'] : []),
    ...(tight ? ['\\begin{preview}'] : []), ...(box ? ['\\begin{minipage}{.95\\linewidth}'] : []), start].filter(Boolean).join('\n') + '\n';
  const tail = [end, ...(box ? ['\\end{minipage}'] : []), ...(tight ? ['\\end{preview}'] : []), '\\end{document}', ''].filter((line, i) => line || i > 0).join('\n');
  return { text: head + fragment + '\n' + tail + '\n', lineOffset:head.split('\n').length - 1, glass, tight };
}

function stopTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide:true, stdio:'ignore' }).on('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
  }
}

function run(command, args, { cwd, env, signal, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('已取消')); return; }
    const child = spawn(command, args, { cwd, env, windowsHide:true, detached:process.platform !== 'win32', stdio:['ignore','pipe','pipe'] });
    let raw = Buffer.alloc(0), timedOut = false;
    const append = data => { raw = Buffer.concat([raw,data]).subarray(-256 * 1024); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const stop = () => stopTree(child);
    signal?.addEventListener('abort', stop, { once:true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      if (signal?.aborted) reject(new Error('已取消'));
      else if (timedOut) reject(new Error('局部预览超时'));
      else resolve({ code, log:raw.toString('utf8') });
    });
  });
}

async function snapshot(paths) {
  return Promise.all(paths.map(async file => {
    try {
      const stat = await fs.stat(file, { bigint:true });
      return [file, stat.mtimeNs.toString(), stat.ctimeNs.toString(), stat.size.toString()];
    } catch { return [file]; }
  }));
}

async function dependencies(directory, cwd) {
  const recorder = await fs.readFile(path.join(directory,'fragment.fls'),'utf8').catch(() => '');
  if (!recorder) return null;
  const paths = [...new Set(recorder.split(/\r?\n/).filter(line => line.startsWith('INPUT '))
    .map(line => path.resolve(cwd,line.slice(6))).filter(file => !file.startsWith(directory + path.sep)))];
  return paths.length < 900 ? snapshot(paths) : null;
}

async function rasterize(pdf, page, options) {
  const out = path.join(path.dirname(pdf),'page-' + page);
  const png = out + '.png';
  try { await fs.access(png); return png; } catch {}
  const result = await run('pdftoppm',['-f',String(page),'-l',String(page),'-singlefile','-scale-to','1450','-png',pdf,out],options)
    .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (result) {
    try { await fs.access(png); return png; } catch { return null; }
  }
  if (process.platform === 'darwin' && page === 1) {
    const image = await run('/usr/bin/sips',['-s','format','png','-Z','1450',pdf,'--out',png],options);
    if (image.code === 0) return png;
  }
  return null;
}

async function pdfPages(pdf, options) {
  const info = await run('pdfinfo',[pdf],options).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return +(info?.log.match(/^Pages:\s*(\d+)/m)?.[1] || 1);
}

async function stageFonts(directory, roots) {
  const font = /\.(?:otf|ttf|ttc|otc|pfb)$/i;
  const seen = new Set();
  const copied = [];
  for (const root of new Set(roots.filter(Boolean))) {
    for (const relative of ['','fonts','font']) {
      const pending = [relative];
      while (pending.length) {
        const folder = pending.pop();
        const source = path.join(root,folder);
        const items = await fs.readdir(source,{ withFileTypes:true }).catch(error => {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
          throw error;
        });
        for (const item of items) {
          const file = path.join(folder,item.name);
          if (relative && item.isDirectory()) pending.push(file);
          if (!font.test(item.name) || !(item.isFile() || item.isSymbolicLink()) || seen.has(file)) continue;
          await fs.mkdir(path.join(directory,folder),{recursive:true});
          await fs.copyFile(path.join(root,file),path.join(directory,file),COPYFILE_FICLONE);
          seen.add(file);
          copied.push(path.join(root,file));
        }
      }
    }
  }
  return copied;
}

async function compile(settings) {
  const { fragment, inherited, sourceDir, mainDir, project, storage, signal, extension, demo, engine } = settings;
  let plan = wrapper(fragment,inherited,demo,false,settings.body);
  const dir = await fs.mkdtemp(path.join(storage, 'fragment-'));
  try {
    const support = path.join(extension,'runtime','glass');
    const cwd = dir;
    const env = { ...settings.env, TEXINPUTS:[mainDir,sourceDir,project,path.join(extension,'media'),
      settings.env.TEXINPUTS,''].filter(value => value !== undefined).join(path.delimiter) };
    const options = { cwd, env, signal };
    if (engine === 'lualatex') {
      const cache = await run('kpsewhich',['-var-value=TEXMFCACHE'],options).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      // TeX Live may reject writes to absolute cache paths with shell escape off.
      // A relative fallback keeps font caches beside the staged TeX file.
      env.TEXMFCACHE = [cache?.code === 0 && cache.log.trim(),'.'].filter(Boolean).join(path.delimiter);
    }
    const fonts = engine !== 'pdflatex' && inherited ? await stageFonts(dir,[mainDir,sourceDir,project]) : [];
    const tex = path.join(dir,'fragment.tex');
    const pdf = path.join(dir,'fragment.pdf');
    await fs.writeFile(tex,plan.text,'utf8');
    const ordinary = () => run(engine, ['-interaction=nonstopmode','-file-line-error','-halt-on-error','-no-shell-escape','-recorder','fragment.tex'],options);
    let result;
    if (!plan.glass) {
      result = await ordinary();
      const receipt = await fs.readFile(path.join(dir,'fragment.lgr'),'utf8').catch(() => '');
      if (result.code === 0 && /^LG\|/m.test(receipt)) {
        // Class and preamble hooks can enable LiquidGlass for an ordinary box.
        plan = wrapper(fragment,inherited,demo,true,settings.body);
        await fs.writeFile(tex,plan.text,'utf8');
      } else if (result.code === 0 && /Rerun to get cross-references right/.test(result.log)) result = await ordinary();
    }
    if (plan.glass) {
      const driver = demo ? path.join(support,'lgbuild.py') : await settings.findDriver(options);
      const glassEnv = { ...env, TEXINPUTS:[mainDir,sourceDir,project,path.join(extension,'media'),
        settings.env.TEXINPUTS,support,''].filter(value => value !== undefined).join(path.delimiter) };
      const python = await settings.python();
      result = await run(python,[path.join(extension,'runtime','preview_driver.py'),driver || path.join(support,'lgbuild.py'),
        settings.assetRoot || (demo ? '' : mainDir || sourceDir || project || ''),tex,'--engine',engine,
        '--no-shell-escape','--bibliography','none','--index','none','--dpi',String(settings.dpi ?? 108)],{ ...options, env:glassEnv, timeout:75000 });
    }
    const log = result.log;
    if (result.code !== 0) {
      const mapped = [...log.matchAll(/(?:^|\n)(?:[^\n]*[/\\])?fragment\.tex:(\d+):[^\S\n]*([^\n]+)/g)]
        .filter(item => !/fatal error occurred|emergency stop/i.test(item[2]));
      const hint = mapped.at(-1);
      const reason = /^! (.+)$/m.exec(log)?.[1] || /Package fontspec Error:[\s\S]*?\(fontspec\)[^\S\n]+([^\n]+)/.exec(log)?.[1]?.trim() || /^.*× (.+(?:quiting|permission denied).*)$/mi.exec(log)?.[1];
      const error = new Error(hint?.[2] || reason || log.trim().split('\n')
        .find(line => /^(?:LiquidGlass:|Error:)/i.test(line)) || 'TeX 无法生成预览');
      error.line = hint ? Number(hint[1]) - plan.lineOffset : null;
      error.log = log;
      throw error;
    }
    await fs.access(pdf);
    const page = await rasterize(pdf,1,options);
    const pages = await pdfPages(pdf,options);
    const deps = plan.glass ? null : await dependencies(dir,cwd);
    if (deps && fonts.length) deps.push(...await snapshot(fonts));
    return { dir,pdf,page,pages,log,options,deps };
  } catch (error) {
    await fs.rm(dir,{recursive:true,force:true});
    if (error.code === 'ENOENT') error.message = '缺少 TeX 引擎、Python 或预览依赖。' + os.EOL + error.message;
    throw error;
  }
}

module.exports = { compile, run, wrapper, preamble, bodyContext, snapshot, rasterize };
