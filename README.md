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
  textures.js         程序化贴图（木地板标线 / 篮球 / 背景渐变）
  player.js           第一人称相机：WASD、阻尼转向、投篮瞄准视角平滑插值
  ball.js             篮球三形态：物理 / 持球 / 运球动画
  states.js           独立状态机：无球 / 原地持球 / 行进运球 / 投篮蓄力
  rhythm.js           卡点拍球判定器（完美区/及格区/周期空过）
  scoring.js          计分、双连击计数器、localStorage 最高分
  effects.js          进球粒子、屏幕震动、Bloom 脉冲
  audio.js            WebAudio 音效管理（含场馆回声感）
  ui.js               DOM 界面控制器
dist/game.js          esbuild 打包产物（浏览器实际加载的普通脚本）
assets/audio/         音效 wav 文件 + sfx.js（base64 内嵌数据包）
tools/gen_audio.js    音效合成生成器（node tools/gen_audio.js 重新生成）
```

## 玩法

| 操作 | 键鼠 |
|---|---|
| 移动 | `W A S D`（左手） |
| 转向 | 鼠标（右手，带阻尼平滑） |
| 拾球 / 卡点拍球 / 按住蓄力 | 鼠标左键 |
| 开始·结束运球 / 假投虚晃 | 鼠标右键 |
| 暂停 | ESC |

- **自由模式**：无限时，运球分 + 投篮分合并计总分。
- **运球限时挑战（90s）**：只比运球分。滚动条进中央按左键：完美区连击+1、
  得分 ×连击倍数（1/2/3 封顶），及格区不涨连击但清失误；连击越高滚动越快。
  连续 3 次失误掉球，捡球可继续，倒计时不停。
- **投篮限时挑战（90s）**：只比投篮分。持球走进三分线投篮区自动切入瞄准视角，
  力度条绿段为"最佳力度"（按抛物线反解实时计算），松开左键出手、右键假投。
  进球有粒子+震屏+刷网音+泛光脉冲；连续 3 不中连击清零；球落地自动回手。
- 三分线外命中 30 分基础、线内 20 分，均乘投篮连击倍数。

三项最高分分别持久化在 localStorage（`fpbb.record.*`），刷新不丢；
挑战结束弹窗附截图分享提示，方便和好友比拼。

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
