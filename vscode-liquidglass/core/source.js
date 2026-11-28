/* The same source spans are used by the Studio canvas and the VS Code host. */
(function (root, factory) {
  if (typeof module === 'object') module.exports = factory();
  else root.LiquidSource = factory();
})(globalThis, () => {
  const names = /^(?:tikzpicture|pgfpicture|scope|axis|semilog[xy]axis|loglogaxis|tcolorbox|tcblisting|glassbox|(?:equation|align|gather|multline|displaymath|math)\*?)$/;
  const knownGlass = /^(?:glassbox|lg(?:theorem|definition|lemma|proposition|corollary|conjecture|example|exercise|problem|remark|application|proof|solution))\*?$/;
  const number = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
  const fields = {
    'lg blur': ['模糊', 0, 12, .1, 2.4], 'lg refraction': ['折射', 0, 2, .01, .35],
    'lg opacity': ['玻璃色覆层', 0, 1, .01, .30], 'lg edge': ['边缘高光', 0, 1, .01, .70],
    'lg sheen': ['表面反光', 0, 1, .01, 0], 'lg sheen x': ['光源横向', 0, 1, .01, .35],
    'lg sheen y': ['光源纵向', 0, 1, .01, .22], 'lg shadow': ['阴影', 0, 1, .01, .12],
    arc: ['圆角', 0, 28, .1, 4, 'mm'], boxrule: ['线宽', 0, 8, .1, .5, 'pt'],
    boxsep: ['内间距', 0, 18, .1, 1, 'mm'], opacityback: ['底色不透明度', 0, 1, .01, 1],
    colback: ['底色', 'color', '#edf4ff'], colframe: ['边框色', 'color', '#587aa0'],
    'line width': ['线宽', 0, 10, .1, .4, 'pt']
  };
  const presets = {
    clear: [ .8, .7, .12, .82, .32, .30, .19, .12 ],
    frosted: [ 4.5, .3, .35, .70, .22, .35, .22, .16 ],
    luminous: [ 2.4, .35, .18, .35, .55, .45, .30, .12 ]
  };
  const glassKeys = Object.keys(fields).filter(key => key.startsWith('lg '));
  const colors = { black:'#000000', white:'#ffffff', red:'#e53535', green:'#16864a', blue:'#335bea',
    cyan:'#00ace0', teal:'#008080', orange:'#ee8b38', violet:'#8254d5', purple:'#8c4197', gray:'#808080',
    yellow:'#e5bf2b', magenta:'#db39ba', LGInk:'#142638', LGPaper:'#f4f8ff', LGShadow:'#142a42' };
  const sample = String.raw`\begin{glassbox}[title={Material study},lg blur=2.4,lg refraction=.55,
  lg opacity=.22,lg edge=.82,lg sheen=.42,lg sheen x=.36,lg sheen y=.21,lg shadow=.18]
Form follows light.
\end{glassbox}`;

  function mask(source) {
    const tokens = /\\\\|\\%|%[^\r\n]*|\\verb\*?([^\w\s])[^\r\n]*?\1|\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted|tcblisting)\}([\s\S]*?)(?=\\end\s*\{\2\})/g;
    return source.replace(tokens, (token, delimiter, env, inner) => {
      const blank = value => value.replace(/[^\r\n]/g, ' ');
      if (env) return token.slice(0, token.length - inner.length) + blank(inner);
      return delimiter || token[0] === '%' ? blank(token) : token;
    });
  }

  function environments(source) {
    const masked = mask(source);
    const stack = [], result = [];
    for (const token of masked.matchAll(/(?<!\\)\\(begin|end)\s*\{([\w@*:-]+)\}/g)) {
      const [, action, name] = token;
      if (action === 'begin') stack.push({ name, start: token.index, head: token.index + token[0].length });
      else if (stack.at(-1)?.name === name) result.push({ ...stack.pop(), tail: token.index, end: token.index + token[0].length });
    }
    return result;
  }

  function fragment(source, start, end) {
    const ranges = environments(source).filter(env => env.name !== 'document');
    const exact = start !== end && ranges.some(env => env.start >= start && env.end <= end);
    if (exact) return { start, end, expanded: false };
    const enclosing = ranges.filter(env => env.start <= start && env.end >= end);
    const tikz = enclosing.find(env => env.name === 'tikzpicture');
    const target = tikz ?? enclosing.find(env => names.test(env.name) || knownGlass.test(env.name)) ?? enclosing[0];
    return target ? { start: target.start, end: target.end, expanded: start !== target.start || end !== target.end }
      : start !== end ? { start, end, expanded: false } : null;
  }

  function optionBlock(source, at) {
    const masked = mask(source);
    const gap = /^\s*/.exec(masked.slice(at))[0].length;
    const start = at + gap;
    if (masked[start] !== '[') return null;
    let braces = 0, brackets = 1, part = start + 1;
    const entries = [];
    function push(end) {
      const match = /^\s*([\w -]+?)\s*=\s*([\s\S]*?)(\s*)$/.exec(masked.slice(part, end));
      if (match) {
        const from = part + match[0].indexOf('=') + 1 + /^\s*/.exec(match[0].split('=')[1])[0].length;
        entries.push({ key: match[1].trim().replace(/\s+/g, ' '), from, to: from + match[2].length, raw: source.slice(from, from + match[2].length) });
      } else {
        const flag = masked.slice(part, end).trim();
        if (flag) entries.push({ key: flag, flag: true });
      }
      part = end + 1;
    }
    for (let i = start + 1; i < source.length; i++) {
      if (masked[i] === '\\') { i++; continue; }
      if (masked[i] === '{') braces++;
      if (masked[i] === '}') braces--;
      if (braces) continue;
      if (masked[i] === '[') brackets++;
      if (masked[i] === ']') brackets--;
      if (brackets === 1 && masked[i] === ',') push(i);
      if (brackets === 0) {
        push(i);
        return { start, end: i + 1, entries };
      }
    }
    return null;
  }

  function color(raw) {
    if (!raw) return null;
    const [base, amount, other = 'white', ...rest] = raw.trim().split('!');
    if (!colors[base] || rest.length || (amount !== undefined && (!colors[other] || !/^\d+(?:\.\d+)?$/.test(amount) || +amount > 100))) return null;
    if (amount === undefined) return colors[base];
    return '#' + [1, 3, 5].map(i => Math.round((parseInt(colors[base].slice(i,i+2),16) * +amount +
      parseInt(colors[other].slice(i,i+2),16) * (100 - +amount)) / 100).toString(16).padStart(2,'0')).join('');
  }

  function property(key, entry, defaultValue) {
    const [label, min, max, step, fallback, unit = ''] = fields[key];
    const raw = entry?.raw;
    if (min === 'color') return { key, label, type: min, value: raw && color(raw) || max, editable: !raw || !!color(raw) };
    const parsed = raw?.match(new RegExp('^(' + number + ')(pt|cm|mm|in|bp)?$'));
    const valid = parsed && (unit ? !!parsed[2] : !parsed[2]);
    const mm = { pt: 25.4/72.27, bp: 25.4/72, cm: 10, mm: 1, in: 25.4 };
    const actualUnit = valid && parsed[2] || unit;
    const factor = unit ? mm[unit] / mm[actualUnit] : 1;
    const value = valid ? Number(parsed[1]) : (defaultValue ?? fallback);
    return { key, label, min: Math.min(min * factor, value), max: Math.max(max * factor, value), step: step * factor,
      value, unit: actualUnit, editable: raw === undefined || Boolean(valid), px: actualUnit ? mm[actualUnit] * value * 96/25.4 : value };
  }

  function describe(source, context) {
    const top = environments(source).sort((a,b) => a.start - b.start)[0];
    if (!top) return /\\(?:draw|path|filldraw|fill|node|coordinate)\b/.test(mask(source))
      ? nakedTikz(source) : { kind:'tex', properties:[] };
    if (top.name === 'tikzpicture') return { kind:'tikz', ...tikz(source, top) };
    const options = optionBlock(source, top.head);
    const byKey = new Map(options?.entries.map(item => [item.key, item]));
    const inheritedGlass = Boolean(context?.beautybook && /^(?:tcolorbox|fancybox)$/.test(top.name));
    const glass = inheritedGlass || knownGlass.test(top.name) || byKey.has('liquid glass') || [...byKey.keys()].some(k => k.startsWith('lg '));
    if (top.name !== 'tcolorbox' && !glass) return { kind:'tex', name:top.name, properties:[] };
    const style = ['clear','frosted','luminous'].find(key => byKey.has('lg ' + key) || byKey.get('lg material')?.raw === key);
    const materials = { clear:[.8,.7,.12,.70,0,.35,.22,.12], frosted:[2.4,.35,.30,.70,0,.35,.22,.12], luminous:presets.luminous };
    const defaults = style ? materials[style] : inheritedGlass ? [.55,.10,0,.7,.14,.26,.32,.10] : undefined;
    const keys = glass ? glassKeys : ['arc','boxrule','boxsep','opacityback','colback','colframe'];
    let bodyStart = options?.end ?? top.head;
    let title = byKey.get('title')?.raw?.replace(/^\{([\s\S]*)\}$/, '$1');
    if (knownGlass.test(top.name) && /^lg/.test(top.name) && !/^lg(?:proof|solution)$/.test(top.name)) {
      const compactTitle = optionBlock(source,bodyStart);
      const args = /^\s*\{([^{}]*)\}(?:\s*\{[^{}]*\})?/.exec(mask(source.slice(compactTitle?.end ?? bodyStart,top.tail)));
      if (args) {
        title ??= args[1];
        bodyStart = (compactTitle?.end ?? bodyStart) + args[0].length;
      }
    }
    const remainder = mask(source.slice(bodyStart, top.tail)).trim();
    return { kind:glass ? 'glass' : 'box', name:top.name, ornate:inheritedGlass && top.name === 'fancybox', title, body:remainder,
      properties:keys.map((key,i) => property(key, byKey.get(key), defaults?.[i])),
      options, head:top.head, partial: inheritedGlass || /^lg/.test(top.name) || !!source.slice(top.end).trim() || !!source.slice(0,top.start).trim() ||
        remainder.includes('\\') || Boolean(options?.entries.some(item => !keys.includes(item.key) && item.key !== 'title')) };
  }

  function nakedTikz(source) {
    const prefix = '\\begin{tikzpicture}\n';
    const model = describe(prefix + source + '\n\\end{tikzpicture}');
    return { ...model, properties:model.properties.map(prop => ({ ...prop, from:prop.from - prefix.length, to:prop.to - prefix.length })) };
  }

  function tikz(source, top) {
    const options = optionBlock(source, top.head);
    const code = mask(source.slice(options?.end ?? top.head, top.tail));
    const base = options?.end ?? top.head;
    const points = Object.create(null), properties = [], shapes = [];
    const pair = new RegExp('^\\(\\s*(' + number + ')\\s*,\\s*(' + number + ')\\s*\\)');
    let partial = Boolean(options);
    const commands = /\\(draw|path|filldraw|fill|coordinate|node)\b([^;]*);/g;
    for (const [commandIndex,command] of [...code.matchAll(commands)].entries()) {
      const arg = command[2], argStart = base + command.index + command[0].length - arg.length - 1;
      const option = optionBlock(source, argStart);
      const restAt = option?.end ?? argStart;
      const rest = mask(source.slice(restAt, argStart + arg.length)).trim();
      const [type, tail] = [command[1], rest];
      if (type === 'coordinate' || type === 'node') {
        const named = /^\s*(?:\(([\w:-]+)\)\s*)?at\s+(\([^)]*\))\s*(?:\{([^{}]*)\})?\s*$/.exec(tail);
        const match = named && pair.exec(named[2]);
        if (!match || option || (!named[1] && type === 'coordinate')) { partial = true; continue; }
        const start = source.indexOf(named[2], restAt + tail.indexOf('at'));
        const id = properties.length;
        const x = start + named[2].indexOf(match[1]);
        const y = start + named[2].indexOf(match[2], named[2].indexOf(',') + 1);
        const p = [+match[1], +match[2]];
        if (named[1]) points[named[1]] = p;
        for (const [index, from] of [x, y].entries()) {
          properties.push({ key:'coord-' + (id+index), label:`${named[1] || '节点'} · ${index ? 'y' : 'x'}`,
            min:Math.min(-10,p[index]), max:Math.max(10,p[index]), step:.05, value:p[index], unit:'', editable:true,
            from, to:from+match[index+1].length });
        }
        if (type === 'node') shapes.push({ type:'text', p, text:named[3] || '' });
        continue;
      }
      const getPoint = identity => {
        const parsed = pair.exec(identity);
        return parsed ? [+parsed[1],+parsed[2]] : Object.hasOwn(points, identity.slice(1,-1)) ? points[identity.slice(1,-1)] : undefined;
      };
      const tokens = [...tail.matchAll(/\([^()]*\)/g)];
      const ops = tail.replace(/\([^()]*\)/g, '@').replace(/\s/g,'');
      const vertex = tokens.map(token => getPoint(token[0]));
      const items = option?.entries ?? [];
      const stroke = items.find(item => item.key === 'draw')?.raw ?? items.find(item => item.flag && color(item.key))?.key;
      const fill = items.find(item => item.key === 'fill')?.raw;
      const width = items.findLast(item => item.key === 'line width');
      const paint = { stroke: type === 'fill' ? 'none' : color(stroke) || '#5266b2',
        fill: (fill || type === 'fill' || type === 'filldraw') ? color(fill || stroke) || '#9aace5' : 'none',
        width: width ? property('line width', width).px : 1.8 };
      if (width) properties.push({ ...property('line width',width), key:'width-'+commandIndex, from:width.from,to:width.to });
      if (items.some(item => !['draw','fill','line width'].includes(item.key) && !color(item.key)) || type === 'path') partial = true;
      if (ops === '@circle@' && vertex[0] && new RegExp('^\\(' + number + '\\)$').test(tokens[1][0])) {
        shapes.push({ type:'circle', p:vertex[0], r: Math.abs(+tokens[1][0].slice(1,-1)), ...paint });
      } else if (vertex.length > 1 && vertex.every(Boolean) && /^@rectangle@$/.test(ops)) {
        shapes.push({ type:'rect', vertex, ...paint });
      } else if (vertex.length > 1 && vertex.every(Boolean) && /^@(?:--@)+(?:--cycle)?$/.test(ops)) {
        shapes.push({ type:'line', vertex, closed:ops.endsWith('cycle'), ...paint });
      } else partial = true;
    }
    if (code.replace(commands,'').trim()) partial = true;
    return { name:'tikzpicture', points, shapes, properties, partial };
  }

  function change(source, key, value, context) {
    const model = describe(source,context);
    const prop = model.properties.find(item => item.key === key);
    if (!prop?.editable) return source;
    let raw;
    if (prop.type === 'color') {
      raw = Object.keys(colors).find(name => colors[name] === value);
      if (!raw) return source;
    } else {
      const n = Number(value);
      if (!Number.isFinite(n) || n < prop.min || n > prop.max) return source;
      raw = String(+n.toFixed(4)) + prop.unit;
    }
    const entry = Number.isInteger(prop.from) ? prop : model.options?.entries.findLast(item => item.key === key);
    if (entry && !entry.flag && !/%/.test(source.slice(entry.from,entry.to))) return source.slice(0,entry.from) + raw + source.slice(entry.to);
    if (model.options) {
      const end = model.options.end - 1;
      const separator = /,\s*$/.test(mask(source.slice(model.options.start+1,end))) || !model.options.entries.length ? '' : ', ';
      return source.slice(0,end) + separator + key + '=' + raw + source.slice(end);
    }
    return source.slice(0,model.head) + '[' + key + '=' + raw + ']' + source.slice(model.head);
  }

  return { mask, environments, fragment, describe, change, presets, glassKeys, sample, colors, knownGlass };
});
