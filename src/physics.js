/**
 * physics.js —— cannon-es 物理世界
 * 负责：重力、材质（弹性/摩擦）、静态碰撞体（地板/墙/篮板/篮圈/支架）。
 * 篮圈用一圈小球的组合体近似（cannon 无圆环碰撞体）。
 */
import * as CANNON from 'cannon-es';
import { CFG } from './config.js';

export function createPhysics() {
  // 世界重力与玩家起跳积分读同一个常数（CFG.player.gravity）
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -CFG.player.gravity, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.defaultContactMaterial.friction = 0.3;
  world.defaultContactMaterial.restitution = 0.3;
  world.allowSleep = true;

  /* ---- 材质 ---- */
  const matFloor = new CANNON.Material('floor');
  const matBall = new CANNON.Material('ball');
  const matRim = new CANNON.Material('rim');
  const matBoard = new CANNON.Material('board');

  world.addContactMaterial(new CANNON.ContactMaterial(matBall, matFloor, {
    friction: 0.35, restitution: CFG.ball.floorRestitution,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(matBall, matRim, {
    friction: 0.25, restitution: CFG.ball.rimRestitution,
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(matBall, matBoard, {
    friction: 0.3, restitution: 0.5,
  }));

  /* ---- 便捷工厂 ---- */
  const addBox = (w, h, d, x, y, z, material, rotY = 0) => {
    const body = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)),
      material,
    });
    body.position.set(x, y, z);
    if (rotY) body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), rotY);
    world.addBody(body);
    return body;
  };
  const addSphere = (r, x, y, z, material) => {
    const body = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Sphere(r), material });
    body.position.set(x, y, z);
    world.addBody(body);
    return body;
  };

  /* ---- 场地几何常量（与渲染层共用同一份 CFG） ---- */
  const rimZ = CFG.hoop.boardFaceZ + CFG.hoop.rimOffset;  // 圈心 z ≈ -12.425
  const rimY = CFG.hoop.rimHeight;

  /* ---- 地板 + 四周墙 + 顶棚（防止球飞出球馆） ---- */
  addBox(CFG.gym.halfW * 2 + 4, 0.2, CFG.gym.halfL * 2 + 4, 0, -0.1, 0, matFloor);       // 地板
  addBox(0.3, CFG.gym.height, CFG.gym.halfL * 2, -CFG.gym.halfW, CFG.gym.height / 2, 0, matFloor);
  addBox(0.3, CFG.gym.height, CFG.gym.halfL * 2, CFG.gym.halfW, CFG.gym.height / 2, 0, matFloor);
  addBox(CFG.gym.halfW * 2, CFG.gym.height, 0.3, 0, CFG.gym.height / 2, -CFG.gym.halfL, matFloor);
  addBox(CFG.gym.halfW * 2, CFG.gym.height, 0.3, 0, CFG.gym.height / 2, CFG.gym.halfL, matFloor);
  addBox(CFG.gym.halfW * 2, 0.3, CFG.gym.halfL * 2, 0, CFG.gym.height, 0, matFloor);      // 顶棚

  /* ---- 篮板（透明玻璃质感，碰撞盒含边框伸出部分） ---- */
  const boardCenterY = CFG.hoop.boardBottomY + CFG.hoop.boardH / 2;
  addBox(CFG.hoop.boardW, CFG.hoop.boardH, CFG.hoop.boardD, 0, boardCenterY, CFG.hoop.boardFaceZ - CFG.hoop.boardD / 2, matBoard);

  /* ---- 篮圈：16 个小球沿环排列 + 圈心不做遮挡（空心） ---- */
  const rimBodies = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    rimBodies.push(addSphere(
      CFG.hoop.rimTube + 0.016, // 略放大防高速穿模
      Math.cos(a) * CFG.hoop.rimRadius, rimY,
      rimZ + Math.sin(a) * CFG.hoop.rimRadius,
      matRim
    ));
  }
  // 篮圈连接板（圈后部与篮板之间的小钢支架）
  addBox(0.12, 0.1, 0.36, 0, rimY - 0.02, CFG.hoop.boardFaceZ + 0.14, matRim);

  /* ---- 篮网上沿柔性阻挡：一圈稍高的隐形小球，模拟篮网对入网球的收束 ---- */
  const netBodies = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    netBodies.push(addSphere(0.02,
      Math.cos(a) * (CFG.hoop.rimRadius - 0.02), rimY - 0.16,
      rimZ + Math.sin(a) * (CFG.hoop.rimRadius - 0.02), matRim));
  }

  /* ---- 篮球动态刚体 ---- */
  const ballShape = new CANNON.Sphere(CFG.ball.radius);
  const ballBody = new CANNON.Body({
    mass: CFG.ball.mass,
    shape: ballShape,
    material: matBall,
    linearDamping: 0.22,
    angularDamping: 0.22,
    allowSleep: true,
    sleepSpeedLimit: 0.25,
    sleepTimeLimit: 1.2,
  });
  ballBody.position.set(0, 5, 0);
  world.addBody(ballBody);

  /* ---- 远端装饰篮板/篮圈：只给碰撞（避免球穿模），几何同上但朝 +z ---- */
  const farFaceZ = CFG.court.halfL - 1.2;
  addBox(CFG.hoop.boardW, CFG.hoop.boardH, CFG.hoop.boardD, 0, boardCenterY, farFaceZ + CFG.hoop.boardD / 2, matBoard);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    addSphere(CFG.hoop.rimTube + 0.008,
      Math.cos(a) * CFG.hoop.rimRadius, rimY,
      farFaceZ - CFG.hoop.rimOffset + Math.sin(a) * CFG.hoop.rimRadius, matRim);
  }

  return { world, ballBody, matFloor, matBall, matRim, matBoard, rimZ, rimY };
}
