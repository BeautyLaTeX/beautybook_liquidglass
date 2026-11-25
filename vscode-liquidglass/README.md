# LiquidGlass Build

在 VS Code 打开 LaTeX 工程，点击左侧 **LiquidGlass** 图标，选择 **pdfLaTeX、XeLaTeX 或 LuaLaTeX**，再点击 **编译**。引擎和 Shell Escape 开关按工作区记忆，右键编译同样使用这两个选项。

圆盘显示按已完成的构建阶段计算的进度。玻璃材质生成时还会统计片段数。构建成功后显示 100%，失败或停止时保留已到达的进度。错误位置和 PDF 入口显示在侧栏，完整日志在底部的 **输出 → LiquidGlass**。配置了 LaTeX Workshop 时可在编辑器标签页预览 PDF。

需要 TeX Live（或 MacTeX）、Python 3.9+ 和 Pillow。LiquidGlass 项目使用项目内的 `lgbuild.py`。普通 LaTeX 项目通过 `latexmk` 编译。可在设置中指定 Python，或用工程的 `.venv`。

扩展解析 `% !TeX root = ...`、完整主文件以及字面量 `\input`、`\include` 和 `\subfile` 的引用。多个主文件引用同一章节时会弹出选择。面板首次使用默认选中 XeLaTeX，Shell Escape 关闭。开关打开后，编译前会确认是否允许本次 TeX 文档执行外部命令。面板的选择优先于项目配置及文件内声明。
