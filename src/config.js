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
  /* ---------- 篮筐（FIBA 标准） ---------- */
  hoop: {
    rimHeight: 3.05,     // 筐沿高度
    rimRadius: 0.228,    // 篮圈半径
    rimTube: 0.017,      // 篮圈钢管半径
    boardFaceZ: -12.8,   // 篮板正面 z 坐标（距端线 1.2m）
    rimOffset: 0.375,    // 圈心到篮板面的距离
    boardW: 1.8, boardH: 1.05, boardD: 0.06,
    boardBottomY: 2.9,   // 篮板下沿高度
    netDepth: 0.45,      // 篮网深度
    // 判定进球：球心自上而下穿过筐平面的水平半径阈值
    scoreRadius: 0.19,
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
    speedHold: 1.9,      // 原地持球（缓慢）
    speedDribble: 5.0,   // 行进运球
    speedShot: 1.2,      // 投篮区域内微调站位
    accel: 14,           // 速度平滑加速度
    sens: 0.0023,        // 鼠标灵敏度（弧度/像素）
    lookDamping: 16,     // 视角阻尼（指数趋近系数，越大越跟手）
    pickupRange: 1.9,    // 拾球距离
    headBob: true,       // 行走头部微晃
  },
  /* ---------- 投篮 ---------- */
  shot: {
    zoneRadius: 6.9,     // 投篮触发区：距圈心水平距离
    zoneMinDist: 1.6,    // 太近不触发（篮下架不住）
    zoneMaxZ: -3.0,      // 必须在自家半场（z 小于该值）
    chargeTime: 1.25,    // 蓄力从 0 到满的时间（秒）
    speedMin: 5.6,       // 出手初速度下限（power=0）
    speedMax: 12.8,      // 出手初速度上限（power=1）
    elevAngle: 52 * Math.PI / 180, // 固定理想抛物线仰角
    sweetHalf: 0.055,    // 力度条最佳区半宽
    aimBlend: 0.55,      // 准星偏移对理想弹道的干扰权重（0=全辅助 1=全手动）
    score2Dist: 6.75,    // 三分线距离：出手点距圈心水平距离大于此为 3 分
    base2: 20,           // 两分基础分
    base3: 30,           // 三分基础分
  },
  /* ---------- 运球节奏条 ---------- */
  dribble: {
    basePeriod: 0.92,    // 连击 0 时滚动周期（秒）
    minPeriod: 0.44,     // 周期下限（最快）
    periodStep: 0.055,   // 每 1 连击缩短量
    perfectHalf: 0.058,  // 完美区半宽（进度比例）
    perfectMin: 0.032,   // 完美区收缩下限
    goodHalf: 0.175,     // 及格区半宽
    goodMin: 0.115,      // 及格区收缩下限
    shrinkPerCombo: 0.004, // 每连击区域收缩
    basePoints: 10,      // 完美拍球基础分
    maxComboMul: 3,      // 连击倍数上限
    comboMul: [1, 1, 2, 3], // 连击 n 的倍数（索引=连击数，3+ 封顶）
    failLimit: 3,        // 连续失败 N 次掉球
    bounceAmp: 0.72,     // 运球动画弹跳幅度（米）
  },
  /* ---------- 挑战模式 ---------- */
  challenge: {
    duration: 90,        // 倒计时秒数
    lastSecondTick: 10,  // 最后 N 秒每秒滴答
  },
  /* ---------- 计分模式枚举 ---------- */
  MODES: {
    free:    { id: 'free',    name: '自由模式',     recordKey: 'fpbb.record.free',    timed: false, dribbleScore: true,  shotScore: true  },
    dribble: { id: 'dribble', name: '运球限时挑战', recordKey: 'fpbb.record.dribble', timed: true,  dribbleScore: true,  shotScore: false },
    shot:    { id: 'shot',    name: '投篮限时挑战', recordKey: 'fpbb.record.shot',    timed: true,  dribbleScore: false, shotScore: true  },
  },
  /* ---------- 视觉 ---------- */
  fx: {
    bloomBase: 0.26,
    bloomScore: 0.95,
    shakeAmp: 0.045,
    shakeDur: 0.28,
  },
};
