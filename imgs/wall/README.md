# imgs/wall —— 墙面二次元贴画

把喜欢的图片（**JPG / PNG / WEBP / GIF / BMP**，单图 ≤8MB）直接丢进本目录，
然后 **双击 `tools/gen_walls.bat`**（或 `npm run walls`）重新生成清单，
刷新游戏即可看到四面墙上自动挂好的海报框。

- 图片按顺序轮流分配到 北 / 南 / 西 / 东 四面墙，每面墙内自动均布、保留原始宽高比。
- `manifest.js` 是生成物（图片以 base64 内嵌），请勿手工编辑。
- 为什么要生成这一步：浏览器在 `file://` 下禁止网页读取目录列表，也禁止把本地
  `<img>` 上传为 WebGL 贴图（画布污染 SecurityError），实测唯一稳妥的离线方案
  就是打包成 data:URL。
