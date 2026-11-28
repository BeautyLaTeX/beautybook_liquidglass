# Beautybook LiquidGlass 7.0.1

Beautybook 是面向数学书稿、讲义和研究笔记的 LaTeX 模板。Beautybook 7.0.1 内置 **LiquidGlass 2.0.2**。LiquidGlass 是模板内置的玻璃材质宏包，也可独立移植到使用 tcolorbox 的文档。

[LiquidGlass 2.0.2 便携包](portable/LiquidGlass-2.0.2.zip) · [图解手册](manual/LiquidGlass-Guide-2.0.2.pdf) · [便携示例源码](portable/example.tex)

## 默认使用原版银蓝玻璃

`\BeautyGlassDefault` 在正文盒子上统一使用 `reading-window`。这套材质复用浅色代码窗的 `@silver` 银蓝底图、原来的白色细亮边和浅灰外沿，以及 `lg lift=float` 的轻柔阴影。标题栏透出少量银蓝底色，与盒面、细白边共用原生圆角。定理、例题、代码和普通盒子沿各自的轮廓绘制。中式 Fancybox 沿用原来的凹角与角饰。标题排版和目录、编号及引用由模板处理。

```latex
\BeautyGlassDefault[lg radius={3mm,northwest=5pt}]
```

`lg material=reading-window` 可以逐盒选择。浅色白边的默认宽度为 `.70pt`，可用 `lg rim width`、`lg rim opacity` 和 `lg rim color` 统一调整。可以用 `\BeautyGlassReading` 选择原阅读配置，或用 `\BeautyGlassDefault[lg material=reading-lens]` 选择局部受光的阅读材质。跨页切口继续使用开放轮廓。

## 照片磨砂玻璃

深色的 `reading-window` 参照本地 `frostglass-final` 的 `frost mist` 成品。以 NumPy 在照片原有的 sRGB 色调下合成 8 mm 和 14.4 mm 扩散，按参考的烟青到暖灰色调着色。默认材质由提供的照片重算，并用参考截图的留白区校准。随包收录经确认可公开发布的无字磨砂底材。

`@reading` 随主题选图。浅色使用 `@silver`，深色使用 `@frost`。指定照片或 `@page` 时会按实际底图计算双尺度扩散。

浅色代码窗使用 minted 的 xcode，深色代码窗使用 monokai。语法色与文档指定的 `style` 由 `minted` 直接输出。深色中文注释加细亮缘辅助辨认，字形填色仍使用 Monokai 默认值。深色标题保留白字，底材减光从标题栏内渐入。底图以 200 ppi 采样，文字和轮廓为 PDF 矢量。


## 2.0 的渲染升级

1. **盒形参与光学计算。** TeX 捕获片段位置时，同时记录实际外轮廓、有效圆角和拆分页状态。NumPy 由有符号距离场建立边缘高度和法线，用斯涅尔折射近似逐像素反向取样。折射沿直边和圆角连续转向。Beautybook 的 Fancybox 以原生凹圆角建模，原框、角饰与标题仍由模板绘制。
2. **Pillow 与 NumPy 分工。** Pillow 处理图片解码、ICC 转换、底图适配与 PNG 输出。NumPy 在 Float32 线性光中处理模糊、颜色、折射和反光。清透材质的边缘使用更细的采样和较低的模糊，银蓝阅读材质保留克制的上缘反光与平缓的中心色层。宽模糊核使用多次盒式卷积近似，并按带采样余量的局部图块处理。
3. **续页保留同一片玻璃。** 注册图像铺满逻辑盒后再裁成各页片段，薄膜、柔光与颗粒使用逻辑盒坐标。页面取样仍来自各片段所在页。跨页切口不形成新的顶边或底边反光。正文、公式、书签、原生边框及 SyncTeX 继续由 LaTeX 生成。
4. **延续两阶段 PDF 构建。** 构建器先确定排版与片段，再生成材质图并交回 TeX 裁切合成。Poppler 负责从捕获版 PDF 读取实际页背景。玻璃盒面局部栅格化，PDF 中的文字和轮廓仍可缩放。整个过程在 CPU 上完成。

| 材质 | 2.0 表现与适用场景 |
| --- | --- |
| `lg material=clear` | 强调边缘弯折、圆角厚度和方向性反光，适合有明显底图纹理的短盒。 |
| `lg material=reading` | 银蓝磨砂的阅读预设，常用于正文较多的定理、定义和证明。 |
| `lg material=reading-window` | 原代码窗银蓝材质，矢量白边和柔影。 |
| `lg material=reading-lens` | 银蓝阅读内区、随光向渐隐的窄边高光和双层悬浮阴影。 |
| `lg material=regular` | 通用磨砂，兼顾底图层次和文字对比。 |
| `lg material=reference` / `opaque` | 原图和实色预设继续使用原版素材路径。 |

以前的 `lg blur`、`lg refraction`、逐角半径与底图接口可继续使用。光学路径中的折射参数会映射成材质的有效深度，同一个数值的边缘位移可以比旧版更明显。需要复现旧书稿外观时，在单盒写 `lg renderer=legacy`，用 `\glasssetup{lg renderer=legacy}` 为整份文档设置，或在构建器命令加 `--renderer legacy` 强制使用 1.6.x 的材质算法。

## 构建模板

完整构建默认以 200 ppi 采样玻璃背景。文字、公式和轮廓由 PDF 保持为矢量。直接运行构建器时可用 `--dpi` 覆盖默认采样密度。

需要 TeX Live 或 MacTeX、Python 3.9+、Pillow 与 NumPy。取样整页或读取 PDF 底图时需要 Poppler 的 `pdftoppm`。在项目根目录执行：

```sh
python3 -m venv "../.$(basename "$PWD").venv"
"../.$(basename "$PWD").venv/bin/python" -m pip install -r liquidglass-requirements.txt
./build.command beautybook-glass-demo.tex --no-open
```

macOS 也可双击 `build.command` 并选择主文档。启动器会查找模板旁边的 `.<模板目录名>.venv`，也支持项目内已有的 `.venv` 或指定的 `LIQUIDGLASS_PYTHON`。Windows 或 Linux 可用安装了依赖的 Python 直接执行 `python lgbuild.py beautybook-glass-demo.tex --engine xelatex`。模板书稿的引擎与 shell escape 配置从 `liquidglass.json` 读取。正式 PDF 写到主文件旁，SyncTeX 在 `build/`。直接用 TeX 编译可查看预览材质。

VS Code 可使用本项目已有的 LaTeX Workshop 配方，或者用 LiquidGlass Studio 对完整文档编译。Studio 2.5.0 的材质实验室提供正式版浅色与深色入口，PDF 实编译使用随插件提供的同版 LiquidGlass。即时预览便于调参。若同时装有两种扩展，可只启用一个自动构建入口，以免同一主文档重复编译。

## 独立使用

解压便携包，把 `liquidglass` 开头的宏包和模块、`liquidglass_optics.py`、`lgbuild.py`、`liquidglass-requirements.txt` 及 `liquidglass-assets/` 放在主文件旁。macOS 可一并使用 `build.command`。

```latex
\documentclass{article}
\usepackage{liquidglass}

\begin{document}
\begin{lgtheorem}[lg material=reading]{Pythagoras}{pythagoras}
  In a right triangle, \(a^2+b^2=c^2\).
\end{lgtheorem}
See Theorem~\ref{lgthm:pythagoras}.
\end{document}
```

使用 `python lgbuild.py main.tex --engine lualatex` 生成完整效果。要观察清透折射，可用 `lg image=@page,lg material=clear`，并让页背景中的直线经过盒边。使用注册图像时，可逐盒设置 `lg image=background.png`，也可用 `\glassbackgroundfolder{images}` 循环选图。

## 工程入口

| 位置 | 用途 |
| --- | --- |
| `beautybook.cls`、`stys/` | 文类、原生框形、封面、字体和版式接入。 |
| `liquidglass.sty`、`liquidglass-*.tex` | 材质键、片段记录、矢量边饰、悬浮阴影和定理。 |
| `lgbuild.py`、`liquidglass_optics.py` | 捕获、取样、CPU 光学渲染和终稿合成。 |
| `portable/`、`manual/` | 便携包、示例和图解手册。 |

LiquidGlass 代码见 [MIT 许可证](liquidglass-LICENSE)。模板内字体和第三方素材适用各自的授权条款。

## English

LiquidGlass 2.0 brings shape-aware refraction and directional rim lighting to static LaTeX PDFs. Pillow handles image I/O and color profiles, while NumPy renders in Float32 linear light on the CPU. The LaTeX compositor retains native outlines, text, equations and document structure. Use `--renderer legacy` to reproduce the 1.6.x material path.
