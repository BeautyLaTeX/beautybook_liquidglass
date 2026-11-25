# Beautybook LiquidGlass

Beautybook LiquidGlass 是一套面向数学书稿、课程讲义和研究笔记的 LaTeX 模板，附带可独立移植的 **LiquidGlass 1.6.3** 宏包。银蓝磨砂底图、柔和悬浮阴影和跨页玻璃定理盒沿用同一套材质。模板保留 Beautybook 的封面、页边栏、卷边标题、代码窗和时间线。

[LiquidGlass 1.6.3 Release](https://github.com/BeautyLaTeX/beautybook_liquidglass/releases/tag/v1.6.3) · [便携 ZIP](https://github.com/BeautyLaTeX/beautybook_liquidglass/releases/download/v1.6.3/LiquidGlass-1.6.3.zip) · [图解手册 PDF](https://github.com/BeautyLaTeX/beautybook_liquidglass/releases/download/v1.6.3/LiquidGlass-Guide-1.6.3.pdf) · [VS Code 扩展](https://github.com/BeautyLaTeX/beautybook_liquidglass/releases/download/v1.6.3/liquidglass-build-1.6.3.vsix)

## 在 VS Code 中编译

下载 `.vsix`，在扩展视图的菜单中选 **从 VSIX 安装**。打开项目后点击左侧 **LiquidGlass** 图标，或右键单击 `.tex` 文件选择 **编译当前 LaTeX 文档**。面板显示构建阶段和可点击的报错，底部 **输出 → LiquidGlass** 提供完整日志。

扩展会解析 `% !TeX root` 和章节引用，自动选择主文件与外部命令权限。普通文档关闭 shell-escape，支持受限模式的 minted 使用 TeX 的命令白名单，需要完整权限时会显示原因并请你确认。项目可通过 `liquidglass.json` 或 `% !TeX shell-escape = true|false|restricted` 指定策略。若使用 LaTeX Workshop 预览 PDF，建议让 LiquidGlass 负责编译并关闭 LaTeX Workshop 的保存时自动构建。

## 使用 Beautybook 模板

安装 TeX Live 或 MacTeX、Python 3.9+ 和 Pillow。在仓库根目录先编译短示例 `beautybook-glass-demo.tex`。macOS 可双击 `build.command` 选择文档，也可在终端运行下面的命令。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install Pillow
./build.command beautybook-glass-demo.tex --no-open
```

也可直接调用构建器。Windows 上虚拟环境的解释器路径是 `.venv\Scripts\python.exe`。

```sh
.venv/bin/python lgbuild.py beautybook-glass-demo.tex --engine xelatex
```

生成的 PDF 在主 `.tex` 文件旁。`cnnotes.tex` 和 `Note.tex` 是中、英文完整书稿。主文件的默认编译引擎由 `liquidglass.json` 配置。取样整页或读取 PDF 底图时需要 Poppler 的 `pdftoppm`。

## 在自己的模板中使用 LiquidGlass

解压便携 ZIP，将其中以 `liquidglass` 命名的 `.sty`、`.tex` 文件，以及 `liquidglass-assets/` 和 `lgbuild.py` 放到主文件同一层。macOS 也可一起复制 `build.command`。打开 [便携示例源码](portable/example.tex) 可查看现成的中文定理、时间线及引用。

```latex
\documentclass{article}
\usepackage{liquidglass}

\begin{document}
\section{Geometry}
\begin{lgtheorem}[lg lift=cloud]{Pythagoras}{pythagoras}
  In a right triangle, \(a^2+b^2=c^2\).
\end{lgtheorem}
See Theorem~\ref{lgthm:pythagoras}.
\end{document}
```

保存为 `main.tex` 后，使用安装了 Pillow 的 Python 运行 `python3 lgbuild.py main.tex --engine lualatex`。中文文档可使用 `ctex`，再通过 `\glasssettheoremlanguage{zh}` 启用中文定理名称。直接用 TeX 编译时会显示主题预览底图。完整构建会完成背景取样、材质合成和分页裁切。

| 想调整 | 可从这里入手 |
| --- | --- |
| 银蓝阅读面 | `lg material=reading`。可换用 `regular`、`clear` 或 `opaque`。 |
| 悬浮感 | `lg lift=cloud`。宽阴影和接触阴影可以分别微调，也可选 `air`。 |
| 单独调整左上圆角 | `lg radius={3mm,northwest=5pt}`。 |
| 使用自己的底图 | 逐盒设置 `lg image=background.png`，或用 `\glassbackgroundfolder{images}` 循环取图。 |
| 套用到现有盒子 | 给 `tcolorbox` 加 `liquid glass`，也可直接用 `glassbox`。 |

## 仓库结构

| 文件或目录 | 内容 |
| --- | --- |
| `beautybook.cls`、`stys/` | 书稿文类、语言配置、封面和原生盒子样式 |
| `liquidglass.sty`、`liquidglass-*.tex` | 玻璃材质接口、阴影和卷边定理预设 |
| `liquidglass-timeline.sty` | 支持跨页和嵌套的时间线 |
| `lgbuild.py`、`build.command` | 完整 PDF 构建器和 macOS 编译菜单 |
| `manual/` | 可重新编译的图解手册及效果图册 |
| `portable/`、`vscode-liquidglass/` | 便携示例与 VS Code 扩展源码 |

LiquidGlass 源码的授权见 [MIT 许可证](liquidglass-LICENSE)。模板随附的字体与第三方素材适用各自的授权条款。

## English

Beautybook LiquidGlass is a LaTeX book template for mathematical writing, with a standalone LiquidGlass package for other projects. The glass material supports registered backgrounds, configurable blur and shadows, and breakable theorem boxes. Start with the [standalone example](portable/example.tex) or run `python3 lgbuild.py beautybook-glass-demo.tex --engine xelatex` from this repository. Full rendering requires TeX Live or MacTeX, Python 3.9+, and Pillow.
