# 第一视角篮球 · FIRST TOUCH HOOPS

纯前端 3D 第一人称篮球单机小游戏：**Three.js 渲染 + cannon-es 真实物理**，
完全离线运行 —— **双击 `index.html` 即可游玩**，无需任何服务器或网络。

## 目录结构

```
index.html            入口（含全部 UI 面板）
css/style.css         界面样式（暗色球馆 + 篮球橙主题）
src/                  ES Module 源码（开发用）
  config.js           全部可调参数（场地/物理/难度/计分/模式定义）
  main.js             入口胶水：渲染循环、输入分发、模式流程
  physics.js          cannon-es 世界：材质弹性、篮板/篮圈碰撞体
  court.js            球馆场景：地板标线、篮架篮网、看台座椅、围栏、灯光
  textures.js         程序化贴图（木地板标线 / 篮球+颗粒凸起 / 墙面吸音板 / 背景渐变）
  player.js           第一人称相机：WASD、阻尼转向、投篮瞄准视角平滑插值
  ball.js             篮球：物理 / 持球（含无门槛拍球动画）
  states.js           独立状态机：无球 / 持球 / 投篮蓄力 + 随机投篮站位
  scoring.js          计分、投篮连击计数器、localStorage 最高分
  effects.js          进球粒子、屏幕震动、Bloom 脉冲
  audio.js            WebAudio 音效管理（含场馆回声感）
  ui.js               DOM 界面控制器
dist/game.js          esbuild 打包产物（浏览器实际加载的普通脚本）
assets/audio/         音效 wav 文件 + sfx.js（base64 内嵌数据包）
imgs/wall/            墙贴画目录：把二次元图片丢进来即可自动上墙（见下）
tools/gen_audio.js    音效合成生成器（node tools/gen_audio.js 重新生成）
tools/gen_walls.bat   墙贴画打包器（双击 或 npm run walls）
```

## 玩法

| 操作 | 键鼠 |
|---|---|
| 移动 | `W A S D`（左手） |
| 转向 | 鼠标（右手，带阻尼平滑） |
| 拾球 | 左键（走近篮球） |
| 拍球（无门槛，+2 分） | 左键**短按** |
| 蓄力投篮（松手出手） | 左键**长按** |
| 假投虚晃 | 鼠标右键 |
| 暂停 | ESC |

- **自由模式**：无限时，拍球分 + 投篮分合并计总分。**全场任意位置都能投篮**：
  长按左键原地起投（镜头自动瞄准篮筐），走入三分区则自动切入瞄准视角；
  短按左键则是零门槛拍球，自动跟手纯氛围。
- **投篮限时挑战（90s）**：开局空投到随机投篮点（距篮 2.6–6.4m）、球已在手，
  点位周围 **1.5m 小圈内可自由走位**调整视角节奏。**每进一球立即随机传送**
  到新投篮点，未中则原地再来；连续 3 不中连击清零；球落地自动回手。
- **计分**：投篮得分 = 基础 20 × **距离倍率** × 连击倍数（1/1/2/3 封顶）。
  距离倍率从 3m 处 ×1.0 线性涨到 25m 处 ×3.0 封顶——球场之内最远也就 ×3，
  远投值钱但不离谱；HUD 实时显示当前站位的距离倍率。
- 篮筐按比 FIBA 标准**略放大一号**（圈半径 0.26m），空心入网更容易、更爽。

两项最高分分别持久化在 localStorage（`fpbb.record.*`），刷新不丢；
挑战结束弹窗附截图分享提示，方便和好友比拼。

## 墙面二次元贴画

球馆四面墙会自动挂载海报框，展示 `imgs/wall/` 里的图片。放图流程：

1. 把 JPG / PNG（也支持 webp/gif/bmp）图片丢进 `imgs/wall/` 目录；
2. 双击 `tools/gen_walls.bat`（或 `npm run walls`）——它把图片打包成
   base64 内嵌的 `imgs/wall/manifest.js`；
3. 刷新游戏，贴画自动均匀分布到四面墙（多张图轮转排布，按宽高等比缩放）。

> 为什么需要打包那一步：`file://` 下浏览器会把本地 `<img>` 视为污染源，
> 直接贴进 WebGL 会抛 SecurityError（实测于 Edge/Chromium）。因此图片必须
> 以 `data:` URL 内嵌，`manifest.js` 就是这一步的产物。目录为空时游戏静默
> 跳过，正常运行。示例图 `sample-anime-girl.png` 可随意删除或替换。

## 开发构建

```bash
npm install          # 依赖：three / cannon-es / esbuild
npm run build        # src/*.js -> dist/game.js（普通脚本，file:// 可直接加载）
npm run watch        # 监听源码自动打包
npm run audio        # 重新合成 assets/audio 音效
```

> 为什么打包成普通脚本：浏览器在 `file://` 下禁止 `<script type="module">` 与
> fetch 本地文件，因此源码用 ES Module 组织、发布时 esbuild 打成 IIFE；
> 音频同理以 base64 内嵌进 `assets/audio/sfx.js`。

## 性能选项

主菜单/暂停面板均有 **软阴影开关**，低配电脑关闭后仅损失阴影，帧率明显提升。
Bloom 泛光固定开启（强度低），进球瞬间自动增强。
阴影已针对地板闪烁做过调优：灯源近乎顶光、投影相机收紧到场地范围、
4096 阴影贴图 + normalBias，地板高光反射降为低强度，画面稳定不拉丝。
