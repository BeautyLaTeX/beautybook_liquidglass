const Material = require('./material');

const stages = {
  paper:String.raw`\pagecolor{OfficialPaper}`,
  natural:String.raw`\glasspagebackground{material-scene.png}`,
  grid:String.raw`\pagecolor{GridPaper}
\AddToHook{shipout/background}{\begin{tikzpicture}[remember picture,overlay]
  \begin{scope}[shift={(current page.south west)},x=1mm,y=1mm]
    \draw[step=7mm,GridInk,opacity=.22] (0,0) grid (132,76);
    \draw[GridInk,opacity=.66,line width=1pt] (0,11) -- (132,64);
    \draw[GridWarm,opacity=.75,line width=1pt] (0,66) -- (132,14);
  \end{scope}\end{tikzpicture}}`,
  dark:String.raw`\pagecolor{DarkPaper}`
};

function proofDocument(input, stage, part) {
  const settings = Material.settings(input);
  const background = Object.hasOwn(stages,stage) ? stages[stage] : stages.natural;
  const fragment = ['first','middle','last'].includes(part);
  const ribbon = settings.values['theorem ribbon'];
  const chinese = ribbon && settings.values['theorem language'] === 'zh';
  const container = ribbon ? 'lgtheorem' : 'glassbox';
  const decorations = ribbon ? '{Optical reading}{lab-proof}' : '';
  const tab = !ribbon && settings.values['glass tab'] ? 'title={Silver and light},' : '';
  const layout = fragment ? 'breakable' : 'unbreakable,height=39mm,valign=center';
  const sample = String.raw`{\large\sffamily Light over paper}\par\medskip
The reading surface and the edge use the same underlying page.
\[\sum_{k=1}^{n} (x_k-\bar{x})^2=\sum_{k=1}^{n}x_k^2-n\bar{x}^{\,2}.\]`;
  const body = fragment ? Array(3).fill(sample).join('\n\\tcbbreak\n') : sample;
  return String.raw`\documentclass[11pt]{article}
\usepackage[paperwidth=132mm,paperheight=76mm,hmargin=14mm,vmargin=12mm]{geometry}
${chinese ? String.raw`\usepackage[UTF8]{ctex}` : ''}
\usepackage{liquidglass}
\definecolor{OfficialPaper}{HTML}{F2F2F2}
\definecolor{GridPaper}{HTML}{E8F0F2}
\definecolor{GridInk}{HTML}{416B83}
\definecolor{GridWarm}{HTML}{AD715C}
\definecolor{DarkPaper}{HTML}{20323C}
${background}
\pagestyle{empty}
\begin{document}
\begin{${container}}[${layout},top=4mm,bottom=4mm,${tab}${Material.style(settings)}]${decorations}
${body}
\end{${container}}
\end{document}
`;
}

function proofPage(part, pages) {
  if (part === 'middle') {
    if (pages < 3) throw new Error('样片没有形成独立的跨页中段。');
    return Math.ceil(pages / 2);
  }
  if (part === 'last') {
    if (pages < 2) throw new Error('样片没有形成跨页尾段。');
    return pages;
  }
  if (part === 'first' && pages < 2) throw new Error('样片没有形成跨页首段。');
  return 1;
}

module.exports = { proofDocument, proofPage };
