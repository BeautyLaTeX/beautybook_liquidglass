# Bundled artwork / 随包素材

The original project artwork is distributed under the package’s MIT license. The locally calibrated frost-chroma.png was generated from a photograph supplied for this project and is included with permission.

模板原创素材随宏包以 MIT 许可提供。照片磨砂底材仅用于本地验收。

- `default.png` (737 × 291): the exact unlettered surface from the first original compatibility-test card. Its soft violet, cool-grey, cyan/green and warm-yellow edges were already rendered with blur, tint, fine grain and a small rim displacement. It contains no title, body text, mathematics, border or shadow. Pair `@default` with `lg reference` to retain the complete texture without repeating those treatments. 高盒和跨页盒完整铺开同一裁片，避免丢失左右配色。
- `reference-source.json`: source-artwork location, original test geometry, material settings and SHA256 provenance. The approximate crop rectangle locates the area in the original artwork; `default.png` is the exact prepared surface. 裁片来源与核对信息。
- `quiet.png`: the optional low-saturation cool-grey/cyan field from version 1.2. 上一版冷灰柔光背景。
- `colorfield.png`: the original complete colourful scene, including fine grid, lettering and geometric shapes. It remains useful for page-sampling demonstrations. 原整幅彩色场景。
- `aurora.png`: original aurora, stars and mountains. 极光示例。
- `checker.png`: deliberately busy checker and colour patches for contrast checks. 高频对比度检查图。
- `fallback-light.png` / `fallback-dark.png`: direct-TeX preview surfaces. They do not replace a current driver build for accurate custom settings. 单次 TeX 排版预览材质。
- `cycle/`: three example inputs for natural filename-order cycling; the first uses the prepared default crop. 循环取图示例。

The exact prepared default's SHA256 is `0b9bbdc67a1b8366f2cdd0b071d07509fcb63e9650487cc80b51613803a3efe9`.


- `frost-chroma.png`: the text-free reference plate computed from the local supplied photograph and calibrated against the provided screenshot. `@frost` uses it directly.
