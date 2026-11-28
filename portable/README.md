# LiquidGlass 2.0.2

独立的 tcolorbox 玻璃材质宏包，适用于 TeX Live 或 MacTeX，支持 pdfLaTeX、XeLaTeX 与 LuaLaTeX。中文随包示例使用 XeLaTeX 或 LuaLaTeX。

2.0 使用 Pillow 读取素材和写出 PNG，用 NumPy 在线性光中计算由真实盒形驱动的折射、模糊和边缘反光。清透预设让弯折沿圆角变化，阅读预设保留平稳的银蓝中心。续页使用逻辑盒坐标延续纹理，在物理切口保持开放边缘。正文、公式、框线、链接和定位由 TeX 排版。

## 原代码窗材质

随包示例以 `\glassbackground{@reading}` 和 `\glasssetup{lg material=reading-window}` 按明暗主题选择阅读底图，配合白色细线和柔影。逐盒选择用 `lg material=reading-window`。需要局部调整时，使用 `lg rim width`、`lg rim opacity` 和 `lg rim color`。

## 照片磨砂玻璃

深色的 `reading-window` 参照本地 `frostglass-final` 的 `frost mist` 成品。以 NumPy 在照片原有的 sRGB 色调下合成 8 mm 和 14.4 mm 扩散，按参考的烟青到暖灰色调着色。默认材质由提供的照片重算，并用参考截图的留白区校准。随包收录经确认可公开发布的无字磨砂底材。

`@reading` 随主题选图。浅色使用 `@silver`，深色使用 `@frost`。指定照片或 `@page` 时会按实际底图计算双尺度扩散。Beautybook 模板的 `macdarkcode` 使用原生 `minted` Monokai 配色，材质层单独处理代码区亮度。


## 运行示例

玻璃底图默认以 200 ppi 采样。文字、公式和轮廓仍由 PDF 保持为矢量。

安装 Python 3.9+ 与项目依赖。页面捕获或 PDF 底图另需 Poppler 的 `pdftoppm`。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r liquidglass-requirements.txt
.venv/bin/python lgbuild.py example.tex
```

macOS 也可双击 `build.command`。Windows 可使用 `.venv\Scripts\python.exe` 运行构建器。中文示例优先取项目自带的方正字体，其次取 Fandol，macOS 也可使用系统宋体。完整的图解见随包 `Guide.pdf`。

## 移植

把以 `liquidglass` 命名的宏包和模块，以及 `lgbuild.py`、`liquidglass_optics.py`、`liquidglass-requirements.txt` 与 `liquidglass-assets/` 放在主文件旁。

```latex
\documentclass{article}
\usepackage{liquidglass}

\begin{document}
\begin{lgtheorem}[lg material=reading]{Pythagoras}{pythagoras}
  In a right triangle, \(a^2+b^2=c^2\).
\end{lgtheorem}
\end{document}
```

`lg material=regular`、`clear` 和 `reading` 默认采用 2.0 的新算法。用 `lg renderer=legacy` 可逐盒复用 1.6.x 外观，`--renderer legacy` 可整份文档回退。只运行 TeX 时会使用预览材质。完整构建才能看到实际底图的折射与磨砂效果。

`lg material=reading-lens` 为可选的银蓝悬浮阅读预设。NumPy 在线性光中分别计算受光边缘的底图位移和细高光，背光底缘延续阅读底色。`lg lift=float` 用原生轮廓绘制短投影与窄接触阴影。`lg rim width` 和 `lg rim opacity` 可统一调节局部高光。独立设置 `lg rim=hairline` 可用矢量细线，`lg rim color` 可为该线改色，`lg rim=classic` 可恢复原有描边。续页切口保持开放。
