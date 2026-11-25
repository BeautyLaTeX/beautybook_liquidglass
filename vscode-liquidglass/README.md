# LiquidGlass Build

在 VS Code 打开 LaTeX 工程，点击左侧 **LiquidGlass** 图标，然后选择 **编译**。也可右键编辑器或资源管理器中的 `.tex` 文件。构建阶段、错误位置和 PDF 入口显示在侧栏，完整日志在底部的 **输出 → LiquidGlass**。配置了 LaTeX Workshop 时可在编辑器标签页预览 PDF。

需要 TeX Live（或 MacTeX）、Python 3.9+ 和 Pillow。LiquidGlass 项目使用项目内的 `lgbuild.py`。普通 LaTeX 项目通过 `latexmk` 编译。可在设置中指定 Python，或用工程的 `.venv`。

扩展解析 `% !TeX root = ...`、完整主文件以及字面量 `\input`、`\include` 和 `\subfile` 的引用。多个主文件引用同一章节时会弹出选择。自动权限检查参考 `liquidglass.json`、`% !TeX shell-escape = true|false|restricted` 和常见外部命令用法。现代 minted 默认使用可检测到的受限命令模式。完整 shell-escape 会先显示主文件与原因，并需要本次确认。
