// ================= AI ホストの 3D アバター(VRM)の描画 =================
// サーバから届く感情(normal/happy/excited/troubled/shy)と VOICEVOX の音声で動かす。
// 読み込みに失敗したら、何もせず元の SVG のイラストを残す(index.html の #avatarBox)。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMExpressionPresetName } from '@pixiv/three-vrm';

// 使うモデル:custom/host.vrm があればそれ(作者の許可を得て非商用に限り同梱。サーバへは deploy.sh が送る)。
// なければ Git に入っている pixiv のサンプルモデル
const MODEL_URLS = ['/static/models/custom/host.vrm', '/static/models/hana.vrm'];

// 感情 → VRM の標準表情の強さ(モデルにない表情は自動で飛ばす)
// 喜びは relaxed(ほほえみ)に happy(目を細めて笑う)を半分ほど足す。happy を強くすると目が閉じ、話しながらだと不自然
const EMOTION_EXPR = {
  normal:   {},
  happy:    { relaxed: 1.0, happy: 0.45 },
  excited:  { relaxed: 1.0, happy: 0.55, surprised: 0.1 },
  troubled: { sad: 0.85 },
  shy:      { relaxed: 0.8, happy: 0.25 },
};
const EXPR_KEYS = ['happy', 'sad', 'angry', 'relaxed', 'surprised'];

function boot() {
  const canvas = document.getElementById('vrmCanvas');
  const stage = canvas && canvas.closest('.stage');
  if (!canvas || !stage) return;

  let renderer, scene, camera, vrm = null;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  } catch (e) {
    console.warn('[vrm] WebGL が使えないため、イラストのまま表示します:', e);
    return;
  }

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(26, 1, 0.1, 20);
  camera.position.set(0, 1.3, 1.45);

  // ライティング:暖色のキーライト(斜め前)+ 弱めの環境光 + 背面からのリムライト(撮影スタジオ風)
  scene.add(new THREE.AmbientLight(0xfffaf3, 1.25));
  const key = new THREE.DirectionalLight(0xfff1e2, 1.35);
  key.position.set(0.8, 1.8, 2.4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xf3f0ea, 0.5);
  rim.position.set(-1.6, 1.4, -1.6);
  scene.add(rim);

  function resize() {
    const w = stage.clientWidth || 640;
    const h = stage.clientHeight || 400;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage);
  resize();

  // ---- 表情・口の状態 ----
  const cur = {}, tgt = {};           // 表情の今の値 / 目標の値
  EXPR_KEYS.forEach(k => { cur[k] = 0; tgt[k] = 0; });
  let mouth = 0;                       // 口の開き 0..1
  let lipActive = false;              // 実際の音声に合わせて口を動かしている
  let fakeTalkUntil = 0;             // 音声がないとき、口を動かし続ける終了時刻
  let blinkT = 1 + Math.random() * 3, blinking = 0;
  let armL = null, armR = null, foreL = null, foreR = null;  // 腕の骨(T ポーズから腕を下ろすため)
  const bone = {};                     // 待機中の動きに使う骨(頭・首・胸・腰・手)
  let flip = 1;                        // VRM 0.x のモデルでは -1(x・z 軸の回転を逆向きに)
  // 待機中のしぐさ:数秒おきにどれか1つ(首をかしげる・横を見る・うなずく)
  const idle = { next: 3 + Math.random() * 3, kind: null, start: 0, dur: 0, side: 1, smile: 0 };
  // 待機中のパフォーマンス:話していないとき、ほとんど休まず体全体で動く(ダンス・手を振る・鼻歌でゆれる)。
  // w は 0..1 の混ぜ具合。急に切り替えず、ふだんの姿勢となめらかに行き来する。話し始めたらすぐにやめる
  const PERF = { dance: 8, wave: 3.2, hum: 6 };            // それぞれの長さ(秒)。hum は鼻歌を歌うように、ゆっくり左右にゆれる
  const perf = { kind: null, shown: null, start: 0, w: 0, quiet: 0, next: 2 + Math.random() * 2 };
  // 視線:マウス(指)のほうを見る。しばらく動かなければ視聴者(カメラ)に戻る
  const lookTarget = new THREE.Object3D();
  scene.add(lookTarget);
  const gaze = { x: 0, y: 0, tx: 0, ty: 0, last: -1e9 };
  window.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height * 0.3;   // 顔のあたりを中心に
    gaze.tx = Math.max(-1, Math.min(1, (e.clientX - cx) / (innerWidth / 2)));
    gaze.ty = Math.max(-1, Math.min(1, (e.clientY - cy) / (innerHeight / 2)));
    gaze.last = performance.now();
  }, { passive: true });

  // ---- 音声から口の動きを解析 ----
  let actx = null, analyser = null, buf = null;
  const connected = new WeakSet();
  function ensureCtx() {
    if (actx) return;
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = actx.createAnalyser();
      analyser.fftSize = 512;
      buf = new Uint8Array(analyser.fftSize);
    } catch (e) { console.warn('[vrm] AudioContext を作れませんでした:', e); }
  }
  function readMouth() {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; s += d * d; }
    return Math.min(1, Math.sqrt(s / buf.length) * 11);
  }

  // ---- 外から使う API(window.HANA) ----
  const setExpr = (name, w) => {
    if (vrm && vrm.expressionManager && vrm.expressionManager.getExpression(name)) {
      vrm.expressionManager.setValue(name, w);
    }
  };
  window.HANA = {
    ready: false,
    setEmotion(emo) {
      EXPR_KEYS.forEach(k => { tgt[k] = 0; });
      const map = EMOTION_EXPR[emo] || EMOTION_EXPR.normal;
      for (const k in map) tgt[k] = map[k];
    },
    /** 待機中のパフォーマンスをすぐに始める(確認用。'dance' / 'wave' / 'hum') */
    perform(kind) { if (PERF[kind]) { perf.kind = perf.shown = kind; perf.start = clock.elapsedTime; } },
    talkFor(ms) { fakeTalkUntil = performance.now() + Math.min(ms || 1500, 12000); },
    resumeAudio() { ensureCtx(); if (actx && actx.state === 'suspended') actx.resume(); },
    attachAudio(el) {
      ensureCtx();
      if (!actx || !analyser) return;
      try {
        if (!connected.has(el)) {
          const src = actx.createMediaElementSource(el);
          src.connect(analyser);
          analyser.connect(actx.destination);
          connected.add(el);
        }
        lipActive = true;
        el.addEventListener('ended', () => { lipActive = false; }, { once: true });
        el.addEventListener('pause', () => { lipActive = false; }, { once: true });
      } catch (e) { console.warn('[vrm] 音声に合わせた口の動きに失敗したため、時間で動かします:', e); }
    },
  };

  // ---- モデルの読み込み ----
  const loader = new GLTFLoader();
  loader.register(p => new VRMLoaderPlugin(p));
  const bar = document.getElementById('vrmLoadBar');
  const loadDone = () => { const b = document.getElementById('vrmLoad'); if (b) b.classList.add('done'); };
  const load = (i) => loader.load(MODEL_URLS[i], (gltf) => {
    try {
      vrm = gltf.userData.vrm;
      // バージョンによってある最適化。あるときだけ呼ぶ
      if (typeof VRMUtils.removeUnnecessaryVertices === 'function') VRMUtils.removeUnnecessaryVertices(gltf.scene);
      if (typeof VRMUtils.removeUnnecessaryJoints === 'function') VRMUtils.removeUnnecessaryJoints(gltf.scene);
      if (typeof VRMUtils.combineSkeletons === 'function') VRMUtils.combineSkeletons(gltf.scene);
      if (vrm.meta && (vrm.meta.metaVersion === '0' || vrm.meta.metaVersion === 0)) {
        VRMUtils.rotateVRM0(vrm);
        // VRM 0.x はモデルの向きが逆(rotateVRM0 で 180° 回している)ので、x・z 軸まわりの回転の向きも逆になる
        flip = -1;
      }
      vrm.scene.traverse(o => { o.frustumCulled = false; });
      scene.add(vrm.scene);

      // 腕を下ろす:初期状態は T ポーズなので、自然に下ろした姿勢の骨を取っておく
      const H = vrm.humanoid;
      armL = H.getNormalizedBoneNode('leftUpperArm');
      armR = H.getNormalizedBoneNode('rightUpperArm');
      foreL = H.getNormalizedBoneNode('leftLowerArm');
      foreR = H.getNormalizedBoneNode('rightLowerArm');
      for (const n of ['hips', 'spine', 'chest', 'neck', 'head', 'leftHand', 'rightHand']) bone[n] = H.getNormalizedBoneNode(n);
      // 目線はカメラ(=視聴者)に向ける
      if (vrm.lookAt) vrm.lookAt.target = lookTarget;

      // 头骨位置を基準に「上半身」を構図:頭の上に少し余白を残し(頭頂が切れない)、目線よりわずかに上から撮る
      const head = vrm.humanoid.getNormalizedBoneNode('head');
      const hp = new THREE.Vector3();
      (head || vrm.scene).getWorldPosition(hp);
      const ty = (head ? hp.y : 1.3) - 0.08;
      camera.position.set(0, ty + 0.03, 1.72);
      camera.lookAt(0, ty, 0);

      window.HANA.ready = true;
      stage.classList.add('vrm-on');
      announceIn = 3;   // 実際に数フレーム描いてから知らせる(下の tick)
      loadDone();
      console.log('[vrm] 花奈の準備ができました');
    } catch (e) {
      vrm = null;
      console.warn('[vrm] 初期化に失敗したため、立ち絵のまま表示します:', e);
      loadDone();
    }
  }, (ev) => {
    if (bar && ev.total) bar.style.width = Math.round(ev.loaded / ev.total * 100) + '%';
  }, (err) => {
    if (i + 1 < MODEL_URLS.length) { load(i + 1); return; }
    console.warn('[vrm] モデルを読み込めなかったため、立ち絵のまま表示します:', err);
    loadDone();
  });
  load(0);

  // ---- 描画のループ ----
  const clock = new THREE.Clock();
  // 読み込み後、最初の描画ではシェーダーの準備に時間がかかる(遅い端末では数秒)。
  // 準備中に立ち絵を消すと何も映らない時間ができるので、実際に描けてから hana-ready を送る(iOS アプリの stage.js が使う)
  let announceIn = 0;
  function tick() {
    requestAnimationFrame(tick);
    const dt = clock.getDelta();
    const t = clock.elapsedTime;

    if (vrm) {
      // ---- 待機中のパフォーマンスを始める・やめる ----
      const talkingNow = lipActive || performance.now() < fakeTalkUntil || mouth > 0.05;
      perf.quiet = talkingNow ? 0 : perf.quiet + dt;
      perf.next -= dt;
      if (!perf.kind && perf.w < 0.01 && perf.next <= 0 && perf.quiet > 1.5) {
        const kinds = ['dance', 'wave', 'hum', 'dance'];
        perf.kind = perf.shown = kinds[Math.floor(Math.random() * kinds.length)];
        perf.start = t;
      }
      if (perf.kind && (talkingNow || t - perf.start > PERF[perf.kind])) {
        perf.kind = null;
        perf.next = 1 + Math.random() * 2;                    // ほとんど休まず次の動きへ(にぎやかに見せる)
      }
      perf.w += ((perf.kind ? 1 : 0) - perf.w) * Math.min(1, dt * (perf.kind ? 2.5 : talkingNow ? 8 : 3));
      const P = perf.w > 0.001 ? perf.shown : null, W = perf.w, pt = t - perf.start;
      // パフォーマンスの姿勢(ふだんの姿勢からの差)。下で W を掛けて足す
      const d = { armL: 0, armR: 0, foreLy: 0, foreRy: 0, foreLz: 0, foreRz: 0, hipsZ: 0, hipsY: 0, spineZ: 0, bounce: 0, roll: 0, yaw: 0, smile: 0 };
      if (P === 'dance') {
        const s = Math.sin(pt * Math.PI * 2 * 0.9);           // 左右のステップ(約 108 BPM)
        d.hipsZ = s * 0.07; d.spineZ = -s * 0.05; d.hipsY = Math.sin(pt * Math.PI * 0.9) * 0.08;
        d.bounce = Math.abs(s) * 0.014;                         // ステップのたびに小さく弾む
        // 両手を顔の横まで上げ(手を振るときと同じ形)、拍に合わせて左右交互に上下させる
        d.armL = 0.6; d.armR = 0.6;
        d.foreLz = 1.5 + 0.22 * s; d.foreRz = -(1.5 - 0.22 * s);
        d.foreLy = -0.45; d.foreRy = 0.45;
        d.roll = s * 0.07; d.smile = 0.7;
      } else if (P === 'wave') {
        d.armR = 0.75;                                         // 右手を横に上げ、ひじから先を立てて振る
        d.foreRz = -1.6 + 0.32 * Math.sin(pt * Math.PI * 2 * 2.2);
        d.foreRy = 0.45;
        d.roll = 0.07; d.smile = 0.7;
      } else if (P === 'hum') {
        const s = Math.sin(pt * Math.PI * 2 * 0.45);          // ゆっくりゆれる
        d.hipsZ = s * 0.04; d.spineZ = -s * 0.02; d.roll = s * 0.12; d.smile = 0.6;
      }

      // 表情をなめらかに切り替える
      EXPR_KEYS.forEach(k => {
        cur[k] += (tgt[k] - cur[k]) * Math.min(1, dt * 8);
        // 待機中のほほえみ(しぐさ・パフォーマンス)は、感情の表情に少し足す
        setExpr(k, k === 'relaxed' ? Math.min(1, cur[k] + Math.max(idle.smile, d.smile * W)) : cur[k]);
      });

      // 口:実際の音声 → なければ時間で動かす → どちらもなければ閉じる
      let m = 0;
      if (lipActive) m = readMouth();
      else if (performance.now() < fakeTalkUntil) m = (0.55 + 0.45 * Math.sin(t * 17)) * 0.7;
      mouth += (m - mouth) * Math.min(1, dt * 20);
      setExpr(VRMExpressionPresetName.Aa, mouth);

      // まばたき(happy を強く入れて目を閉じているときは飛ばす)
      blinkT -= dt;
      if (blinkT <= 0 && cur.happy < 0.7) { blinking = 0.001; blinkT = 2.5 + Math.random() * 3.5; }
      if (blinking > 0) {
        blinking += dt;
        const b = blinking < 0.07 ? blinking / 0.07 : Math.max(0, 1 - (blinking - 0.07) / 0.1);
        setExpr(VRMExpressionPresetName.Blink, b);
        if (blinking > 0.17) { blinking = 0; setExpr(VRMExpressionPresetName.Blink, 0); }
      }

      // ---- 体の動き(毎フレーム設定し直す。update に上書きされないように) ----
      // 呼吸:胸がゆっくり上下し、肩もわずかに動く
      const breath = Math.sin(t * 1.25);
      if (armL) armL.rotation.z = flip * (-1.2 + breath * 0.015 + d.armL * W);
      if (armR) armR.rotation.z = flip * (1.2 - breath * 0.015 - d.armR * W);
      // ひじを少し曲げ、手を体の少し前に(まっすぐ下ろしたままだと棒立ちに見える)
      if (foreL) { foreL.rotation.z = flip * (-0.1 + d.foreLz * W); foreL.rotation.y = -0.22 + d.foreLy * W; }
      if (foreR) { foreR.rotation.z = flip * (0.1 + d.foreRz * W); foreR.rotation.y = 0.22 + d.foreRy * W; }
      if (bone.chest) bone.chest.rotation.x = flip * breath * 0.012;
      // 重心の移動:腰がゆっくり左右に傾き、背骨で打ち消してまっすぐ立つ
      const sway = Math.sin(t * 0.45);
      if (bone.hips) { bone.hips.rotation.z = flip * (sway * 0.022 + d.hipsZ * W); bone.hips.rotation.y = d.hipsY * W; }
      if (bone.spine) { bone.spine.rotation.z = flip * (-sway * 0.018 + d.spineZ * W); bone.spine.rotation.x = flip * breath * 0.006; }

      // 頭:いくつかの遅い揺れを重ねて、規則的に見えないようにする
      let yaw = 0.06 * Math.sin(t * 0.37) + 0.03 * Math.sin(t * 0.83 + 1.3);
      let pitch = 0.025 * Math.sin(t * 0.51 + 0.7);
      let roll = 0.02 * Math.sin(t * 0.29 + 2.0) + d.roll * W;
      yaw += d.yaw * W;
      // 待機中のしぐさ(話している最中は始めない)
      idle.next -= dt;
      if (!idle.kind && idle.next <= 0 && mouth < 0.05) {
        const kinds = ['tilt', 'glance', 'nod', 'smile', 'tilt', 'smile'];
        idle.kind = kinds[Math.floor(Math.random() * kinds.length)];
        idle.start = t; idle.dur = idle.kind === 'nod' ? 1.1 : idle.kind === 'smile' ? 2.8 : 2.2; idle.side = Math.random() < 0.5 ? -1 : 1;
      }
      if (idle.kind) {
        const p = (t - idle.start) / idle.dur;
        if (p >= 1) { idle.kind = null; idle.smile = 0; idle.next = 1 + Math.random() * 1.5; }
        else {
          const e = Math.sin(Math.PI * p);                       // 0 → 1 → 0 となめらかに
          if (idle.kind === 'tilt') roll += 0.11 * e * idle.side;
          if (idle.kind === 'glance') yaw += 0.16 * e * idle.side;
          if (idle.kind === 'nod') pitch += 0.09 * Math.sin(Math.PI * 2 * p) * (1 - p);
          if (idle.kind === 'smile') { idle.smile = 0.55 * e; roll += 0.06 * e * idle.side; }
        }
      }
      // 視線:マウスのほうへ。目が先に動き、頭は少しだけついていく
      if (performance.now() - gaze.last > 2500) { gaze.tx = 0; gaze.ty = 0; }
      gaze.x += (gaze.tx - gaze.x) * Math.min(1, dt * 6);
      gaze.y += (gaze.ty - gaze.y) * Math.min(1, dt * 6);
      lookTarget.position.set(camera.position.x + gaze.x * 0.9, camera.position.y - gaze.y * 0.6, camera.position.z);
      yaw += gaze.x * 0.22;
      pitch += gaze.y * 0.1;
      // 話しているとき:声の大きさに合わせて小さくうなずく
      pitch += mouth * 0.04 * Math.sin(t * 5.5);
      if (bone.neck) { bone.neck.rotation.y = yaw * 0.4; bone.neck.rotation.x = flip * pitch * 0.4; }
      if (bone.head) { bone.head.rotation.y = yaw * 0.6; bone.head.rotation.x = flip * pitch * 0.6; bone.head.rotation.z = flip * roll; }
      // 感情が excited のときは、体ごと小さく弾む
      vrm.scene.position.y = (cur.surprised > 0.05 ? Math.abs(Math.sin(t * 6)) * 0.006 * cur.relaxed : 0) + d.bounce * W;

      vrm.update(dt);
    }
    renderer.render(scene, camera);
    if (announceIn > 0 && --announceIn === 0) window.dispatchEvent(new Event('hana-ready'));
  }
  tick();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
