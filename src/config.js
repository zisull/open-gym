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
  /* ---------- 篮筐（比 FIBA 标准放大 1.25 倍，休闲友好） ---------- */
  hoop: {
    rimHeight: 3.05,     // 筐沿高度
    rimRadius: 0.325,    // 篮圈半径（标准 0.2286 × 1.25 ≈ 0.286 再放宽，擦筐进更容易）
    rimTube: 0.017,      // 篮圈钢管半径
    boardFaceZ: -12.8,   // 篮板正面 z 坐标（距端线 1.2m）
    rimOffset: 0.375,    // 圈心到篮板面的距离
    boardW: 1.8, boardH: 1.05, boardD: 0.06,
    boardBottomY: 2.9,   // 篮板下沿高度
    netDepth: 0.45,      // 篮网深度
    // 判定进球：球心自上而下穿过筐平面的水平半径阈值
    scoreRadius: 0.28,
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
    accel: 13,           // 起速速率（1/s，指数逼近，帧率无关）：0.2s 吃到 93% 顶速
    brake: 8.5,          // 松开方向键后的滑行减速速率（比旧写法多一小段缓冲）
    airControl: 0.45,    // 空中操控权重：跳起后保留动量，又能微调落点
    jumpSpeed: 4.4,      // 起跳初速（apex≈0.99m，滞空≈0.9s）
    gravity: 9.82,
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
  /* ---------- 拍球（自动跟手的装饰动作） ---------- */
  tap: {
    points: 2,           // 自由模式每次拍球得分
    dur: 0.42,           // 单次拍球动画时长（秒）
    every: [0.62, 0.4],  // 自动拍球间隔：站着慢拍 → 全速快拍
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
  /* ---------- 电影院（球馆 +z 墙红门进入；影厅为圆筒黑匣子，环墙皆银幕） ---------- */
  cinema: {
    // 球馆侧入口门：玩家走进该圆区域自动传送进影厅
    gymDoor: { x: 6.0, z: 16.35, r: 1.25 },
    // 影厅。角度约定与 THREE.CylinderGeometry 完全一致：
    // theta = 0 在 +z 方向，x = R·sin(theta)，z = R·cos(theta)，俯视逆时针递增
    // 厅里**没有出口门**（墙是一整圈闭合的黑匣子），回球场走放映条按钮
    ring: { r: 10.5, height: 7.0 },
    // 弧形银幕：**全厅只有一个高度 h，永不随片数缩放**（屏多就裁画面两侧，屏少就裁上下，
    // 绝不拉伸变形）。每块屏尽量吃满自己的等分槽位弧，最宽只到「按自身宽高比排」的
    // maxWide 倍（再宽画面就废了），剩下的才留给墙，所以片源够多就一定铺满一整圈。
    // h 顶到接近贴天花板（厅高 7.0，屏面占 0.1~6.9，与地/顶都不共面，避免闪烁）
    // cy 为屏心离地高度，defAr 是元数据到位前用的默认宽高比
    screen: { h: 6.8, cy: 3.5, maxWide: 1.6, defAr: 16 / 9 },
    maxScreens: 12, // 环形排布屏数上限（再多每块就太挤了）
    // 多边形厅的内切半径系数（键 = 边数，缺省 1 = 与圆筒同距）：
    // 三/四边形的墙本来就比一块 16:9 幕宽得多，收小半径让幕基本铺满直墙、观看距离也更 IMAX
    polyK: { 3: 0.72, 4: 0.86, 5: 0.95 },
    // 在床上的滚轮变焦：fov 从相机默认值线性拉到 min（越大越贴近画面）
    zoom: { min: 30, step: 0.07 },
    // 中央圆形小床（无围栏无靠背，视线全程通透）：sitR 为就坐时距心半径，eyeSit 为落座视高，
    // lookUp 为落座仰角（弧度）——把视线抬到银幕带中心（屏心 3.5m），一坐下就看到画面
    bed: { x: 0, z: 0, r: 2.5, sitR: 1.8, eyeSit: 1.15, lookUp: 0.27 },
    walkSpeed: 3.0,
  },
  /* ---------- 台球室（球馆 +Z 端墙左侧的绿门进入；独立场景 + 台面 2D 物理） ---------- */
  pool: {
    gymDoor: { x: -6.0, z: 16.35, r: 1.25 }, // 球馆侧入口（与电影院红门左右对称）
    room: { halfW: 4.9, halfL: 6.4, height: 3.1 },
    // 台面：库内沿半长/半宽按标准 9 尺台比例（2.54 x 1.27）；h 为呢绒上表面离地高度
    table: { h: 0.82, halfL: 1.27, halfW: 0.635, railW: 0.13, frame: 0.62 },
    ball: { r: 0.03 },
    // 袋口：r = 球心进入判定的半径（比标准略宽，休闲好进袋）；两个 mouth 是库边在袋口处留的缺口
    pocket: { r: 0.078, cornerMouth: 0.105, sideMouth: 0.088 },
    // 台面物理（2D）：滚阻 = decel + drag*速度（慢球靠常数项刹住、快球多耗在空气/呢绒上），
    // 库边恢复/切向摩擦、球-球恢复、静止阈值、子步数、单杆最长解算时间
    phys: { decel: 0.95, drag: 0.35, cushionRest: 0.72, cushionFric: 0.965, ballRest: 0.96, stop: 0.02, sub: 8, maxTime: 9 },
    speed: [0.6, 6.6],    // 出杆初速区间（力度 0 → 1）
    chargeTime: 1.0,      // 蓄力 0→1 用时（秒）
    cancelCharge: 0.05,   // 低于此力度视为收杆，不出手
    // 上手视角：眼睛在母球正后方 dist、高于球心 drop，看向前方 look 米处的球心
    aim: { sens: 0.0026, dist: 0.52, drop: 0.34, look: 1.0, blend: 11 },
    reach: 1.15,          // 距台边多近可以「上手」（矩形判定，四边都好使）
    walkSpeed: 3.0,
    guide: { dash: 0.045, gap: 0.03, objLen: 0.46, cueLen: 0.3, cushLen: 0.52 },
    score: { ball: 20, clear: 100, foul: 30 },
  },
};
