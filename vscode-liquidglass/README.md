# LiquidGlass LaTeX Studio 2.4

在 VS Code 左侧打开 **LiquidGlass LaTeX Studio**。**打开材质实验室**可即时调节 LiquidGlass 的主题、折射、模糊、蒙版、柔光、边缘、两层阴影、逐角圆角和注册底图。工作台只生成样式，提供盒内参数、全局 \glasssetup 和命名样式三种格式。

## 材质样片

材质实验室提供正式版银蓝和冷暖磨砂两个入口，使用同版底材与渲染器。即时预览用于调参，**PDF 实编译**调用随扩展提供的 LiquidGlass 2.0.2，验证真实折射、圆角、阴影与跨页切口。样片可放大，调整参数后可重新编译。书稿构建继续使用工程里的驱动。模糊和折射按毫米展示，边缘线宽为 pt，阴影和圆角尺寸为 mm。取景适用于注册图像的等比填充，亮部压缩适用于浅色主题。

阶段图在末尾的路径栏显示主文档、临时构建目录、输出 PDF、SyncTeX 和失败日志。绿色颗粒圆盘按实际构建阶段推进，阶段内没有已知的剩余时长时只做动画。普通 LaTeX 走 latexmk，LiquidGlass 工程走工程里的原生驱动。可在面板看到当前轮次、材质片段数量、重新采集、引用工具和下一步。带文件及行号的错误可以点击定位，「打开日志」会在编辑器中打开只读日志标签，编译时会继续更新。

## 兼容

扩展 ID 仍为 `BeautyLaTeX.liquidglass-latex-studio`，可与旧版 `BeautyLaTeX.liquidglass-build` 同时安装，原有工作区选择及 Python 设置继续使用。沿用项目设置时，由 `liquidglass.json` 和文档声明确定引擎。编译保留信任工作区要求和 Shell Escape 按次确认。已安装 LaTeX Workshop 时可沿用它的 PDF 查看器。

macOS 在缺少 Poppler 时用 PDFKit 显示 PDF 页面。Windows / Linux 的页图预览需要 Poppler。普通构建依赖 TeX Live / MacTeX 和 Python 3.9+，LiquidGlass 2.0 光学构建还需要 Pillow 和 NumPy。现有选区试编命令仍可使用。

运行 `python3 tools/package.py <路径>` 打包。运行 `LG_TEX_TEST=1 node --test tests/core.test.js` 验证 JavaScript 逻辑和原生 TeX。
