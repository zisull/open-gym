/**
 * config.js —— 全局配置常量
 * 所有可调的游戏参数集中在此，方便平衡性调整。
 */

export const CFG = {
  /* ---------- 场地尺寸（标准篮球场 28m x 15m，单位：米） ---------- */
  court: {
    halfW: 7.5,          // 边线半宽（x 方向）
    halfL: 14.0,         // 端线半长（z 方向）
  },
  /* ---------- 球馆外壳（物理墙 + 视觉墙） ---------- */
  gym: {
    halfW: 9.8,
    halfL: 16.6,
    height: 9.2,
    // 玩家可活动范围比球体场地小，禁止进入场边座椅区
    playerMinX: -9.0, playerMaxX: 9.0,
    playerMinZ: -15.0, playerMaxZ: 15.8,
  },
  /* ---------- 篮筐（比 FIBA 标准略放大一号，休闲友好） ---------- */
  hoop: {
    rimHeight: 3.05,     // 筐沿高度
    rimRadius: 0.26,     // 篮圈半径（标准 0.2286，加大让"擦筐进"更常见）
    rimTube: 0.017,      // 篮圈钢管半径
    boardFaceZ: -12.8,   // 篮板正面 z 坐标（距端线 1.2m）
    rimOffset: 0.375,    // 圈心到篮板面的距离
    boardW: 1.8, boardH: 1.05, boardD: 0.06,
    boardBottomY: 2.9,   // 篮板下沿高度
    netDepth: 0.45,      // 篮网深度
    // 判定进球：球心自上而下穿过筐平面的水平半径阈值
    scoreRadius: 0.225,
  },
  /* ---------- 篮球 ---------- */
  ball: {
    radius: 0.12,
    mass: 0.62,
    // 物理参数
    floorRestitution: 0.72,
    rimRestitution: 0.55,
  },
  /* ---------- 玩家（相机化身，不渲染人物模型） ---------- */
  player: {
    eye: 1.68,           // 视高
    speedIdle: 5.4,      // 无球跑动
    speedHold: 3.2,      // 持球移动
    speedShot: 0.9,      // 投篮站位微调
    accel: 14,           // 速度平滑加速度
    sens: 0.0023,        // 鼠标灵敏度（弧度/像素）
    lookDamping: 16,     // 视角阻尼（指数趋近系数，越大越跟手）
    pickupRange: 1.9,    // 拾球距离
    headBob: true,       // 行走头部微晃
  },
  /* ---------- 投篮 ---------- */
  shot: {
    zoneRadius: 6.9,     // 投篮触发区：距圈心水平距离（走入自动切入瞄准）
    zoneMinDist: 1.6,    // 太近不触发（篮下架不住）
    zoneMaxZ: -3.0,      // 自动切入瞄准只限进攻端半场
    chargeTime: 1.35,    // 蓄力从 0 到满的时间（秒）
    cancelCharge: 0.06,  // 左键点按低于该蓄力值 -> 视为取消，不出手不记出手数
    speedMin: 5.6,       // 出手初速度下限（power=0）
    speedMax: 17.5,      // 出手初速度上限（power=1，足够覆盖全场最远端线角）
    elevAngle: 52 * Math.PI / 180, // 固定理想抛物线仰角
    sweetHalf: 0.055,    // 力度条最佳区半宽
    aimBlend: 0.55,      // 准星偏移对理想弹道的干扰权重（0=全辅助 1=全手动）
    score2Dist: 6.75,    // 三分线距离：仅用于"三分/两分"称号
    base: 20,            // 投篮基础分
    // 距离倍率：≥distMulMin 米起 1.0x，随距离线性涨到 distMulCap 封顶（球场内 ≤3x）
    distMulMin: 3, distMulFull: 25, distMulCap: 3,
    maxComboMul: 3,      // 连击倍数上限
    comboMul: [1, 1, 2, 3], // 连击 n 的倍数（索引=连击数，3+ 封顶）
    // 投篮挑战：随机站位（距圈心 2.6~6.4m）+ 点位周围小圈自由走位微调
    randomSpotMin: 2.6, randomSpotMax: 6.4,
    spotRadius: 1.5,     // 允许离开随机点的最大半径（米）
    adjustSpeed: 2.4,    // 挑战模式站位微调移速
  },
  /* ---------- 拍球（无门槛装饰动作） ---------- */
  tap: {
    points: 2,           // 自由模式每次拍球得分
    dur: 0.42,           // 拍球动画时长（秒）
  },
  /* ---------- 挑战模式 ---------- */
  challenge: {
    duration: 90,        // 倒计时秒数
    lastSecondTick: 10,  // 最后 N 秒每秒滴答
  },
  /* ---------- 计分模式枚举 ---------- */
  MODES: {
    free: { id: 'free', name: '自由模式', recordKey: 'fpbb.record.free', timed: false, tapScore: true, shotScore: true },
    shot: { id: 'shot', name: '投篮限时挑战', recordKey: 'fpbb.record.shot', timed: true, tapScore: false, shotScore: true },
  },
  /* ---------- 视觉 ---------- */
  fx: {
    bloomBase: 0.26,
    bloomScore: 0.95,
    shakeAmp: 0.045,
    shakeDur: 0.28,
  },
  /* ---------- 电影院（球馆 +z 墙红门进入；影厅为独立场景） ---------- */
  cinema: {
    // 球馆侧入口门：玩家走进该圆区域自动传送进影厅
    gymDoor: { x: 6.0, z: 16.35, r: 1.25 },
    // 影厅外壳尺寸（中心在原点）
    halfW: 9.0, halfL: 7.0, height: 7.0,
    // 观众席：4 排 x 7 座，逐排升高
    rows: [
      { z: -1.6, y: 0.0 },
      { z: 0.6, y: 0.5 },
      { z: 2.8, y: 1.0 },
      { z: 5.0, y: 1.5 },
    ],
    cols: 7, colSpacing: 1.2,
    eyeSit: 1.18,          // 入座视高（相对台基）
    walkSpeed: 3.0,
    // 出口门（影厅 +z 墙）：走进 -> 回球馆
    exitDoor: { x: 6.5, z: 6.9, r: 1.15 },
    // 银幕（16:9，位于 -z 前墙）
    screenW: 9.2, screenH: 5.18, screenY: 3.4, screenZ: -6.9,
    // video/ 清单生成器单文件内嵌上限（字节），超过则提示改用"选择视频"
    maxEmbedMB: 80,
  },
};
