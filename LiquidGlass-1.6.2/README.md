# LiquidGlass 1.6.2

把包内以 `liquidglass` 命名的全部 `.sty`、`.tex`，以及 `liquidglass-assets/` 和 `lgbuild.py` 放在主 `.tex` 同一层。macOS 可一起复制 `build.command`，双击选择文件。完整示例和图解分别见 `example.pdf`、`Guide.pdf`。

需要 TeX Live 或 MacTeX（含 tcolorbox）、Python 3.9+ 和 Pillow。取样页面或以 PDF 为源图时还需要 Poppler 的 `pdftoppm`。如系统 Python 无法直接安装 Pillow，可用 `python3 -m venv .venv`，再用 `.venv/bin/python -m pip install Pillow`。macOS 启动器会寻找同目录的 `.venv`。

```latex
\documentclass{article}
\usepackage{liquidglass}
\begin{document}
\section{Geometry}
\begin{lgtheorem}{Pythagoras}{pythagoras}
  In a right triangle, \(a^2+b^2=c^2\).
\end{lgtheorem}
\end{document}
```

直接运行 `python3 lgbuild.py main.tex --engine xelatex` 也可生成完整效果。单跑 TeX 会用主题预览图。蒙版、模糊、折射和像素对比度保护由构建器渲染。

预置盒与 Beautybook 共用曲线标题签、折边和右下饰带的绘图代码。盒内采用原版的留白和正文层次。编号环境依次接收可选的盒子参数、标题和标签后缀。默认英文，中文文档使用 `ctex` 后可写 `\glasssettheoremlanguage{zh}`。切换材质用 `lg material=regular`、`lg material=clear`、`lg material=opaque` 或 `lg material=reading`。宽阴影和接触阴影可分别调节。

用 `\begin{lgtimeline}` 和 `\lgtimelineitem` 排版同款时间线。正文的实际字体由模板决定。随包示例用 TeX Live 的 Fandol 宋、楷、黑搭配。已有 Beautybook 字体的用户可让示例从 `fonts/` 读取，也可在导言区指定 `\LiquidGlassFontRoot` 的路径，末尾保留斜线。

```latex
\glasssetup{lg lift=cloud,lg shadow blur=6.2mm,lg contact opacity=.019}
```

旧有 `liquid glass` 样式和 `glassbox` 接口仍可用于手动套到已有 tcolorbox。移植包内的定理预设统一使用卷边风格。

编辑手册时，可从包目录运行 `latexmk -lualatex -outdir=build manual/guide.tex`。随包的 `manual/effects.pdf` 是供手册嵌入的配图库。
