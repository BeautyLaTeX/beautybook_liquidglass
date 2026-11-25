const vscode = acquireVsCodeApi();
const get = id => document.getElementById(id);
const gauge = get('gauge');
const canvas = get('dial');
const context = canvas.getContext('2d');
const radios = [...document.querySelectorAll('input[name="engine"]')];
const shell = get('shell');
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
const TURN = Math.PI * 2;
const START = -Math.PI / 2;
const particles = Array.from({ length: 32 }, (_, index) => ({
  angle: index * 2.399963,
  distance: 110 + index % 7 * 2.9,
  size: .6 + index % 5 * .22,
  speed: .05 + index % 4 * .024
}));

let target = 0;
let displayed = 0;
let phase = 'idle';
let busy = false;
let frame = null;
let visible = document.visibilityState !== 'hidden';
let transition = null;

for (const action of ['build', 'cancel', 'pdf', 'output']) {
  get(action).addEventListener('click', () => vscode.postMessage({ action }));
}

function select() {
  const engine = radios.find(input => input.checked)?.value;
  vscode.postMessage({ action: 'select', engine, shellEscape: shell.checked });
}
for (const input of [...radios, shell]) input.addEventListener('change', select);

function stroke(radius, begin, end, color, width) {
  context.beginPath();
  context.arc(0, 0, radius, begin, end);
  context.strokeStyle = color;
  context.lineWidth = width;
  context.stroke();
}

function circle(x, y, radius, color) {
  context.beginPath();
  context.arc(x, y, radius, 0, TURN);
  context.fillStyle = color;
  context.fill();
}

function draw(time) {
  frame = null;
  if (!visible) return;

  if (transition) {
    const t = Math.max(0, Math.min(1, (time - transition.start) / transition.duration));
    displayed = transition.from + (target - transition.from) * (1 - (1 - t) ** 3);
    if (t === 1) transition = null;
  }
  get('percent').textContent = String(Math.round(displayed));

  if (context) {
    const side = canvas.clientWidth;
    const resolution = Math.max(1, Math.round(side * Math.min(window.devicePixelRatio || 1, 2.5)));
    if (canvas.width !== resolution || canvas.height !== resolution) canvas.width = canvas.height = resolution;
    context.setTransform(resolution / 280, 0, 0, resolution / 280, resolution / 2, resolution / 2);
    context.clearRect(-140, -140, 280, 280);
    const active = busy && !motion.matches;
    const seconds = active ? time / 1000 : 0;
    const palette = phase === 'error' ? { start: '#ad4e64', mid: '#ed8290', head: '#ffe1e3', glow: '#ed7588' }
      : phase === 'canceled' ? { start: '#6c7181', mid: '#8e9aa9', head: '#d2dbe7', glow: '#9bacc3' }
      : { start: '#2380a2', mid: '#49d7b8', head: '#e1fff3', glow: '#54e8d4' };

    const halo = context.createRadialGradient(0, 0, 52, 0, 0, 132);
    halo.addColorStop(0, 'transparent');
    halo.addColorStop(.55, 'rgba(66,232,206,' + (active ? .14 + .05 * Math.sin(seconds * 2.1) : .08) + ')');
    halo.addColorStop(1, 'transparent');
    circle(0, 0, 132, halo);

    for (const particle of particles) {
      const angle = particle.angle + seconds * particle.speed;
      const radius = particle.distance + 3 * Math.sin(particle.angle + seconds * .8);
      const alpha = .19 + .25 * ((1 + Math.sin(particle.angle * 3 + seconds * 1.8)) / 2);
      context.globalAlpha = alpha + (busy ? .2 : 0);
      circle(Math.cos(angle) * radius, Math.sin(angle) * radius, particle.size, '#a6fced');
    }
    context.globalAlpha = 1;

    for (let tick = 0; tick < 60; tick++) {
      const angle = START + tick * TURN / 60;
      const major = tick % 5 === 0;
      const outer = 116;
      const inner = major ? 110 : 113;
      context.beginPath();
      context.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
      context.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
      context.strokeStyle = major ? '#a1e6df69' : '#91bac048';
      context.lineWidth = major ? 1.15 : .65;
      context.stroke();
    }

    const glass = context.createRadialGradient(-32, -56, 4, 0, 0, 111);
    glass.addColorStop(0, '#39667252');
    glass.addColorStop(.61, '#14364033');
    glass.addColorStop(1, '#08141c38');
    circle(0, 0, 92, glass);
    stroke(89, 0, TURN, '#a1e4e21d', .8);
    stroke(91, START - 1.15, START + .82, '#a9f8ef33', .9);
    stroke(101, 0, TURN, '#0b1921', 12);
    stroke(101, 0, TURN, '#52a5ad34', 8);
    stroke(106, 0, TURN, '#9ee8df21', .85);

    if (active) {
      const orbit = START + seconds * .63;
      context.save();
      context.shadowBlur = 10;
      context.shadowColor = palette.glow;
      for (let tail = 0; tail < 12; tail++) {
        context.globalAlpha = (12 - tail) / 34;
        stroke(122, orbit - tail * .034 - .04, orbit - tail * .034, palette.mid, .85);
      }
      context.globalAlpha = 1;
      circle(Math.cos(orbit) * 122, Math.sin(orbit) * 122, 1.55, palette.head);
      context.restore();
    }

    if (displayed > 0) {
      const end = START + TURN * displayed / 100;
      const gradient = context.createConicGradient?.(START, 0, 0) || context.createLinearGradient(-101, 0, 101, 0);
      gradient.addColorStop(0, palette.start);
      gradient.addColorStop(Math.max(.02, .6 * displayed / 100), palette.mid);
      gradient.addColorStop(Math.max(.03, displayed / 100), palette.head);
      gradient.addColorStop(1, palette.head);
      context.save();
      context.lineCap = 'round';
      context.shadowBlur = busy ? 18 : 12;
      context.shadowColor = palette.glow;
      stroke(101, START, end, gradient, 7);
      circle(Math.cos(end) * 101, Math.sin(end) * 101, 3.8, palette.head);
      context.restore();
    }
  }

  if ((busy && !motion.matches) || transition) schedule();
}

function schedule() {
  if (frame === null && visible) frame = requestAnimationFrame(draw);
}

function updateProgress(progress, reset) {
  if (progress === target && !reset) return;
  target = progress;
  gauge.setAttribute('aria-valuenow', String(progress));
  if (motion.matches || reset || target === displayed) {
    displayed = target;
    transition = null;
  } else {
    transition = { from: displayed, start: performance.now(), duration: progress === 100 ? 360 : 260 };
  }
}

window.addEventListener('message', ({ data }) => {
  const reset = data.progress === 0 && (data.phase === 'idle' || data.phase === 'inspect');
  phase = data.phase;
  busy = data.busy;
  updateProgress(data.progress, reset);
  get('file').textContent = data.file || '选择一个 .tex 文件';
  get('phase').textContent = data.title;
  const instrument = gauge.parentElement;
  instrument.dataset.phase = phase;
  instrument.dataset.running = String(busy && phase !== 'done' && phase !== 'error');
  get('detail').textContent = data.detail;
  get('detail').hidden = !data.detail;
  get('build').disabled = busy;
  get('engines').disabled = busy;
  shell.disabled = busy;
  for (const input of radios) input.checked = input.value === data.selection.engine;
  shell.checked = data.selection.shellEscape;
  get('cancel').hidden = !busy;
  get('pdf').hidden = !data.pdf;
  get('problems').replaceChildren(...data.problems.map((entry, index) => {
    const li = document.createElement('li');
    const link = document.createElement('button');
    const location = document.createElement('small');
    link.textContent = entry.message;
    location.textContent = entry.file.split(/[\\/]/).pop() + ' · ' + entry.line;
    link.append(location);
    link.addEventListener('click', () => vscode.postMessage({ action: 'jump', index }));
    li.append(link);
    return li;
  }));
  get('errors').hidden = data.problems.length === 0;
  schedule();
});

new ResizeObserver(schedule).observe(gauge);
motion.addEventListener('change', () => {
  if (motion.matches) {
    transition = null;
    displayed = target;
  }
  schedule();
});
document.addEventListener('visibilitychange', () => {
  visible = document.visibilityState !== 'hidden';
  if (!visible && frame !== null) {
    cancelAnimationFrame(frame);
    frame = null;
  }
  schedule();
});
schedule();
vscode.postMessage({ action: 'ready' });
