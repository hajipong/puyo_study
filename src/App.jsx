import { useState, useEffect, useRef } from 'react'
import './App.css'

const ROWS = 14; // 盤面を14段に拡張
const COLS = 6;
const COLORS = ['red', 'green', 'blue', 'yellow']; // 黄色を追加
// 回転方向: 0=上, 1=右, 2=下, 3=左
const DIRS = [
  { dr: -1, dc: 0 }, // 上
  { dr: 0, dc: 1 },  // 右
  { dr: 1, dc: 0 },  // 下
  { dr: 0, dc: -1 }  // 左
];

const SPEED_LEVELS = [10000, 2000, 1000, 500]; // 速度段階: 0=10000ms, 1=2000ms, 2=1000ms, 3=500ms

// 空の盤面を生成（上=0, 下=ROWS-1）
function createEmptyField() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

// ランダムな2色の組ぷよを生成
function getRandomPair() {
  return [
    COLORS[Math.floor(Math.random() * COLORS.length)],
    COLORS[Math.floor(Math.random() * COLORS.length)]
  ];
}

// 盤面から4つ以上繋がった同色ぷよのグループを探索
function findConnectedPuyos(field) {
  const visited = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  const groups = [];
  const drc = [
    [1, 0], [-1, 0], [0, 1], [0, -1]
  ];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!field[r][c] || visited[r][c]) continue;
      const color = field[r][c];
      const stack = [[r, c]];
      const group = [[r, c]];
      visited[r][c] = true;
      while (stack.length) {
        const [cr, cc] = stack.pop();
        for (const [dr, dc] of drc) {
          const nr = cr + dr, nc = cc + dc;
          if (
            nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS &&
            !visited[nr][nc] && field[nr][nc] === color
          ) {
            visited[nr][nc] = true;
            stack.push([nr, nc]);
            group.push([nr, nc]);
          }
        }
      }
      if (group.length >= 4) groups.push({ color, cells: group });
    }
  }
  return groups;
}

// 指定したグループのぷよを消去（nullに）
function erasePuyos(field, groups) {
  // まず盤面をコピー
  const newField = field.map(row => [...row]);
  // 消すべきセル座標のみnullにする
  const toErase = new Set();
  for (const group of groups) {
    for (const [r, c] of group.cells) {
      toErase.add(r + ',' + c);
    }
  }
  for (const pos of toErase) {
    const [r, c] = pos.split(',').map(Number);
    newField[r][c] = null;
  }
  return newField;
}

// 盤面の全列に重力を適用し、下に詰める
function applyGravity(field) {
  const newField = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  for (let c = 0; c < COLS; c++) {
    let writeRow = ROWS - 1;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (field[r][c] !== null) {
        newField[writeRow][c] = field[r][c];
        writeRow--;
      }
    }
    // 上に残ったセルはnullのまま
  }
  return newField;
}

// 指定fallY（1/2マス単位）がまたがる盤面行インデックスを返す
function getCoveredRows(fallY) {
  const base = Math.floor(fallY / 2);
  const rows = [];
  if (base >= 0 && base < ROWS) rows.push(base);
  if (fallY % 2 !== 0 && base + 1 >= 0 && base + 1 < ROWS) rows.push(base + 1);
  return rows;
}

// 下からn段目の盤面インデックスを取得（下=0, 上=ROWS-1）
function fromBottom(n) {
  return ROWS - 1 - n;
}

function App() {
  const [field, setField] = useState(createEmptyField());
  const [pair, setPair] = useState(null); // 初期はnull
  // pairPosにrotationを含める
  const [pairPos, setPairPos] = useState(null); // { fallY, col, rotation }
  const [gameOver, setGameOver] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [landing, setLanding] = useState(false); // 着地待機中
  const [highlightCells, setHighlightCells] = useState([]); // デバッグ用ハイライト
  // rotation stateは廃止（pairPos.rotationを使う）
  // const [rotation, setRotation] = useState(0); // 0=上,1=右,2=下,3=左
  const [error, setError] = useState(null); // エラー表示用
  const [isDownPressed, setIsDownPressed] = useState(false); // 追加: ↓キー押下状態
  const [speed, setSpeed] = useState(2); // デフォルト2(1000ms)
  const intervalRef = useRef();
  const pairSeqRef = useRef(0); // 組ぷよ連番
  // 追加: キー押下状態をuseRefで管理
  const keyStateRef = useRef({ left: false, right: false, z: false, x: false });
  // rotationRef, pairPosRefはpairPos.rotation参照に統一
  const pairPosRef = useRef(pairPos);
  useEffect(() => { pairPosRef.current = pairPos; }, [pairPos]);
  // 追加: 着地待機カウント
  const [landWait, setLandWait] = useState(0);
  const landedRef = useRef(false);
  // landWaitCountをuseRefで管理（tickごとにのみ更新）
  const landWaitCount = useRef(0);
  // --- 追加: 着地カウント・前回値をuseRefで管理 ---
  const prevCanFallRef = useRef(true);
  const prevFallYRef = useRef(null);
  const prevColRef = useRef(null);
  const prevRotRef = useRef(null);

  // 新組ぷよ生成
  const spawnNewPair = () => {
    const newPair = getRandomPair();
    setPair(newPair);
    // 組ぷよのスタート位置は13段目（地面から13段目, index=ROWS-13）
    setPairPos({ fallY: (ROWS-13)*2, col: 2, rotation: 0 });
  };

  // 新組ぷよ生成の副作用（初期・連鎖・消去後すべて）
  useEffect(() => {
    if (!pair && !gameOver) {
      // スタート位置を13段目（地面から13段目, index=ROWS-13）に合わせて判定
      const baseRow = ROWS - 13;
      const dir = DIRS[0];
      const subRow = baseRow + dir.dr;
      const subCol = 2 + dir.dc;
      // baseRow/subRow/subColが盤面内かどうかをチェック
      const canSpawn =
        field[baseRow][2] === null &&
        subRow >= 0 && subRow < ROWS && subCol >= 0 && subCol < COLS &&
        field[subRow][subCol] === null;
      if (canSpawn) {
        spawnNewPair();
        pairSeqRef.current += 1;
      } else {
        setGameOver(true);
      }
    }
    // eslint-disable-next-line
  }, [pair, gameOver]);

  // ★ 新しい組ぷよが出現したときだけ着地カウントをリセット
  useEffect(() => {
    landWaitCount.current = 0;
    setLandWait(0);
  }, [pair]); // pairPos依存を外す

  // キーボード操作（即時反応、setLandingは呼ばない。横移動・回転・速度変更）
  useEffect(() => {
    if (gameOver || erasing || landing || !pair || !pairPos) return;
    const handleKeyDown = (e) => {
      if (e.repeat) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        setPairPos(pos => {
          if (!pos) return pos;
          const dir = e.key === 'ArrowLeft' ? -1 : 1;
          const newCol = Math.round(pos.col) + dir;
          if (newCol < 0 || newCol >= COLS) return pos;
          const rot = pos.rotation;
          // 下側ぷよ
          const mainRows = getCoveredRows(pos.fallY);
          // 上側ぷよ
          const upDir = DIRS[rot];
          const subY = pos.fallY + upDir.dr;
          const subCol = newCol + upDir.dc;
          const subRows = getCoveredRows(subY);
          for (const r of mainRows) {
            if (field[r][newCol]) return pos;
          }
          for (const r of subRows) {
            if (subCol < 0 || subCol >= COLS || field[r][subCol]) return pos;
          }
          return { ...pos, col: newCol };
        });
      } else if (e.key === 'z' || e.key === 'x') {
        if (!pairPos) return;
        const nextRot = e.key === 'z' ? (pairPos.rotation + 3) % 4 : (pairPos.rotation + 1) % 4;
        let { fallY, col } = pairPos;
        col = Math.round(col);
        const dir = DIRS[nextRot];
        // 回転後の子ぷよ座標
        let testFallY = fallY;
        let testCol = col;
        let canRotate = true;
        let rotated = false;
        let doubleRotated = false;
        for (let lift = 0; lift < 4; lift++) { // 最大2マス分持ち上げ
          const subY = testFallY + dir.dr * 2;
          const subCol = testCol + dir.dc;
          let blocked = false;
          if (
            subCol < 0 || subCol >= COLS ||
            subY < 0 || (subY / 2) >= ROWS - 0.5 ||
            getCoveredRows(subY).some(r => r >= ROWS || r < 0 || field[r][subCol])
          ) {
            // 横方向接触判定
            if (dir.dc !== 0 && dir.dr === 0) {
              const moveDir = -dir.dc; // 逆方向
              const newCol = testCol + moveDir;
              const newSubCol = newCol + dir.dc;
              const canMove =
                newCol >= 0 && newCol < COLS &&
                newSubCol >= 0 && newSubCol < COLS &&
                getCoveredRows(testFallY).every(r => r >= 0 && r < ROWS && !field[r][newCol]) &&
                getCoveredRows(subY).every(r => r >= 0 && r < ROWS && !field[r][newSubCol]);
              if (canMove) {
                setPairPos(pos => pos ? { ...pos, col: newCol, fallY: testFallY, rotation: nextRot } : pos);
                rotated = true;
                break;
              } else {
                // 逆側も塞がっていたらもう1回転
                const doubleRot = e.key === 'z' ? (nextRot + 3) % 4 : (nextRot + 1) % 4;
                // 2回転後の座標・方向で下方向の持ち上げ判定
                const doubleDir = DIRS[doubleRot];
                let doubleFallY = testFallY;
                let doubleCol = testCol;
                let canDoubleRotate = false;
                for (let lift2 = 0; lift2 < 4; lift2++) {
                  const subY2 = doubleFallY + doubleDir.dr * 2;
                  const subCol2 = doubleCol + doubleDir.dc;
                  let blocked2 = false;
                  if (
                    subCol2 < 0 || subCol2 >= COLS ||
                    subY2 < 0 || (subY2 / 2) >= ROWS - 0.5 ||
                    getCoveredRows(subY2).some(r => r >= ROWS || r < 0 || field[r][subCol2])
                  ) {
                    blocked2 = true;
                  }
                  if (
                    doubleCol < 0 || doubleCol >= COLS ||
                    doubleFallY < 0 || Math.floor(doubleFallY / 2) >= ROWS ||
                    getCoveredRows(doubleFallY).some(r => r >= ROWS || r < 0 || field[r][doubleCol])
                  ) {
                    canDoubleRotate = false;
                    break;
                  }
                  if (!blocked2) {
                    canDoubleRotate = true;
                    break;
                  }
                  doubleFallY--;
                }
                if (canDoubleRotate) {
                  setPairPos(pos => pos ? { ...pos, fallY: doubleFallY, col: doubleCol, rotation: doubleRot } : pos);
                  doubleRotated = true;
                  break;
                } else {
                  // 2回転＋持ち上げも無理なら回転不可
                  canRotate = false;
                  break;
                }
              }
            }
            blocked = true;
          }
          if (
            testCol < 0 || testCol >= COLS ||
            testFallY < 0 || Math.floor(testFallY / 2) >= ROWS ||
            getCoveredRows(testFallY).some(r => r >= ROWS || r < 0 || field[r][testCol])
          ) {
            canRotate = false;
            break;
          }
          if (!blocked) {
            canRotate = true;
            break;
          }
          testFallY--;
        }
        if (!canRotate || rotated || doubleRotated) return;
        setPairPos(pos => pos ? { ...pos, fallY: testFallY, col: testCol, rotation: nextRot } : pos);
      } else if (e.key === 'ArrowDown') {
        setIsDownPressed(true);
      } else if (e.key === 'q' || e.key === 'Q') {
        setSpeed(s => Math.max(0, s - 1));
      } else if (e.key === 'e' || e.key === 'E') {
        setSpeed(s => Math.min(3, s + 1));
      }
    };
    const handleKeyUp = (e) => {
      if (e.key === 'ArrowDown') {
        setIsDownPressed(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [gameOver, erasing, landing, field, pair, pairPos]);

  // ↓ボタン物理押下状態を常に反映するためのグローバル監視
  useEffect(() => {
    const checkDownKey = (e) => {
      if (e.key === 'ArrowDown') {
        setIsDownPressed(e.type === 'keydown');
      }
    };
    window.addEventListener('keydown', checkDownKey);
    window.addEventListener('keyup', checkDownKey);
    return () => {
      window.removeEventListener('keydown', checkDownKey);
      window.removeEventListener('keyup', checkDownKey);
    };
  }, []);

  // erasingが終わったタイミングで物理的に↓が押されていなければisDownPressedをfalseに
  useEffect(() => {
    if (!erasing) {
      if (!window.navigator.getGamepads || !Array.from(window.navigator.getGamepads()).some(gp => gp && gp.buttons[13]?.pressed)) {
        // キーボード↓が押されていなければfalse
        if (!window.document.activeElement || window.document.activeElement !== document.body) {
          // フォーカスがbody以外なら無視
          return;
        }
        // 物理的に↓が押されていなければfalse
        if (!window.isDownArrowPressed) setIsDownPressed(false);
      }
    }
  }, [erasing]);

  // --- useRef: ゲームパッドごとにボタン状態・keydown発火済みを管理 ---
  const prevButtonsRef = useRef({}); // { [gamepad.index]: { left, right, ... } }
  const keydownFiredRef = useRef({}); // { [gamepad.index]: { left, right, ... } }

  // ゲームパッド入力をキーボードイベントにマッピング（複数台対応・1回押しで1回keydown/keyup）
  useEffect(() => {
    let rafId;
    const buttonMap = {
      left: 14,   // D-Pad Left
      right: 15,  // D-Pad Right
      down: 13,   // D-Pad Down
      b: 1,       // B button
      a: 0,       // A button
      lt: 6,      // LT (L2)
      rt: 7       // RT (R2)
    };
    const keyMap = {
      left: 'ArrowLeft',
      right: 'ArrowRight',
      down: 'ArrowDown',
      b: 'x', // B→x
      a: 'z', // A→z
      lt: 'q',
      rt: 'e'
    };
    const threshold = 0.5;
    function fireKeyEvent(type, key) {
      const event = new KeyboardEvent(type, { key });
      window.dispatchEvent(event);
    }
    function pollGamepad() {
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      if (gamepads) {
        for (const gp of gamepads) {
          if (!gp) continue;
          const idx = gp.index;
          if (!prevButtonsRef.current[idx]) prevButtonsRef.current[idx] = { left:false, right:false, down:false, b:false, a:false, lt:false, rt:false };
          if (!keydownFiredRef.current[idx]) keydownFiredRef.current[idx] = { left:false, right:false, down:false, b:false, a:false, lt:false, rt:false };
          const prevButtons = prevButtonsRef.current[idx];
          const keydownFired = keydownFiredRef.current[idx];
          // D-Pad（axes優先、なければbuttons）
          let left = false, right = false, down = false;
          if (gp.axes.length >= 2) {
            left = gp.axes[0] < -threshold;
            right = gp.axes[0] > threshold;
            down = gp.axes[1] > threshold;
          }
          left = left || gp.buttons[buttonMap.left]?.pressed;
          right = right || gp.buttons[buttonMap.right]?.pressed;
          down = down || gp.buttons[buttonMap.down]?.pressed;
          // B, A, LT, RT
          const b = gp.buttons[buttonMap.b]?.pressed;
          const a = gp.buttons[buttonMap.a]?.pressed;
          const lt = gp.buttons[buttonMap.lt]?.pressed;
          const rt = gp.buttons[buttonMap.rt]?.pressed;
          const states = { left, right, down, b, a, lt, rt };
          for (const key in states) {
            if (states[key]) {
              if (!keydownFired[key]) {
                fireKeyEvent('keydown', keyMap[key]);
                keydownFired[key] = true;
              }
            } else {
              if (keydownFired[key]) {
                fireKeyEvent('keyup', keyMap[key]);
                keydownFired[key] = false;
              }
            }
            prevButtons[key] = states[key];
          }
        }
      }
      rafId = requestAnimationFrame(pollGamepad);
    }
    rafId = requestAnimationFrame(pollGamepad);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  // 落下可能か判定する関数
  function canFall(fallY, col, rot, field) {
    col = Math.round(col);
    // 下側ぷよ
    const mainRowsNow = getCoveredRows(fallY);
    // 上側ぷよ
    const dir = DIRS[rot];
    const subYNow = fallY + dir.dr * 2;
    const subCol = col + dir.dc;
    const subRowsNow = getCoveredRows(subYNow);
    // 下側
    if (mainRowsNow.length > 0) {
      const maxMain = Math.max(...mainRowsNow);
      if (fallY % 2 === 0 && (maxMain + 1 >= ROWS || (maxMain + 1 >= 0 && field[maxMain + 1][col]))) return false;
    }
    // 上側
    if (subRowsNow.length > 0) {
      const maxSub = Math.max(...subRowsNow);
      if (subCol < 0 || subCol >= COLS) return false;
      else if ((subYNow % 2 === 0) && (maxSub + 1 >= ROWS || (maxSub + 1 >= 0 && field[maxSub + 1][subCol]))) return false;
    }
    return true;
  }

  // 落下処理（4回連続で落下不可なら着地、カウント中は落下しない）
  useEffect(() => {
    landedRef.current = false; // 新しい組ぷよが出たらリセット
    if (gameOver || erasing || landing || !pair || !pairPosRef.current) return;
    let prevFallY = null, prevCol = null, prevRot = null;
    let prevCanFall = true;
    // 速度段階に応じてインターバルを決定
    const getInterval = () => (isDownPressed ? 100 : SPEED_LEVELS[speed]);
    intervalRef.current = setInterval(() => {
      // ここで現在の位置・回転・落下可否を取得
      const pos = pairPosRef.current;
      if (!pos || landedRef.current) return;
      let { fallY, col, rotation } = pos;
      col = Math.round(col);
      const canFallNow = canFall(fallY, col, rotation, field);
      if (!canFallNow) {
        landWaitCount.current = Math.min(landWaitCount.current + 1, 4);
      }
      setLandWait(landWaitCount.current);
      prevFallY = fallY;
      prevCol = col;
      prevRot = rotation;
      prevCanFall = canFallNow;
      if (landWaitCount.current >= 4) {
        landedRef.current = true;
        setTimeout(() => setLanding('wait'), 0);
        return;
      }
      if (!canFallNow) {
        return;
      }
      // 落下可能な場合のみ位置を更新
      setPairPos(pos => pos ? { ...pos, fallY: pos.fallY + 1 } : pos);
    }, getInterval());
    return () => clearInterval(intervalRef.current);
  }, [gameOver, erasing, landing, field, pair, isDownPressed, speed]); // 速度・加速状態の変化でinterval再生成

  // 着地待機→固定化処理
  useEffect(() => {
    if (landing !== 'wait' && (!landing || landing === false)) return;
    if (!pair || !pairPos) return;
    if (landing === 'wait') {
      const { fallY, col, rotation } = pairPos;
      // 行インデックスはそのまま
      const mainRow = Math.floor(fallY / 2);
      setLanding({ row: mainRow, col: Math.round(col), pair, rotation });
      return;
    }
    if (!landing || landing === true) return;
    setField(f2 => {
      const { row, col, pair, rotation: landRotation } = landing;
      let newField = f2.map(r => [...r]);
      let conflict = false;
      // ゲームオーバー判定: 13段目（row=ROWS-13）・3列目（col=2）
      // ここでの判定は削除（分離落下・重力適用後のみ判定）
      // if (row === (ROWS-13) && col === 2) {
      //   setGameOver(true);
      // }
      // それ以外はゲームオーバーにしない
      if (row >= 0 && row < ROWS) {
        if (newField[row][col]) conflict = true;
        else newField[row][col] = pair[1];
      }
      const dir = DIRS[landRotation];
      const upRow = row + dir.dr;
      const upCol = col + dir.dc;
      if (upRow >= 0 && upRow < ROWS && upCol >= 0 && upCol < COLS) {
        if (newField[upRow][upCol]) conflict = true;
        else newField[upRow][upCol] = pair[0];
      }
      if (conflict) {
        setLanding(false);
        setPair(null);
        setPairPos(null);
        return f2;
      }
      // 分離落下
      const puyos = [
        { color: pair[1], r: row, c: col },
        { color: pair[0], r: upRow, c: upCol }
      ];
      for (const p of puyos) {
        if (p.r < 0 || p.r >= ROWS || p.c < 0 || p.c >= COLS) continue;
        let dropTo = p.r;
        while (dropTo + 1 < ROWS && !newField[dropTo + 1][p.c]) {
          dropTo++;
        }
        if (dropTo !== p.r) {
          newField[dropTo][p.c] = p.color;
          newField[p.r][p.c] = null;
        }
      }
      newField = applyGravity(newField);
      // 分離落下・重力適用後にゲームオーバー判定
      if (newField[ROWS-13][2] !== null) {
        setGameOver(true);
      }
      const groups = findConnectedPuyos(newField);
      if (groups.length > 0) {
        setErasing(true);
        setPair(null);
        setPairPos(null);
        // 連鎖処理
        const chainErase = (targetField) => {
          const chainGroups = findConnectedPuyos(targetField);
          if (chainGroups.length === 0) {
            setErasing(false);
            setLanding(false);
            setHighlightCells([]);
            setField(() => targetField);
            return;
          }
          const cells = chainGroups.flatMap(g => g.cells.map(([r, c]) => r + ',' + c));
          setHighlightCells(cells);
          setTimeout(() => {
            setHighlightCells([]);
            setTimeout(() => {
              const erased = erasePuyos(targetField, chainGroups);
              const afterGravity = applyGravity(erased);
              setField(() => afterGravity);
              setTimeout(() => chainErase(afterGravity), 0);
            }, 500);
          }, 500);
        };
        const cells = groups.flatMap(g => g.cells.map(([r, c]) => r + ',' + c));
        setHighlightCells(cells);
        setTimeout(() => {
          setHighlightCells([]);
          setTimeout(() => {
            const erased = erasePuyos(newField, groups);
            const afterGravity = applyGravity(erased);
            setField(() => afterGravity);
            setTimeout(() => chainErase(afterGravity), 0);
          }, 500);
        }, 500);
        return newField;
      } else {
        setPair(null);
        setPairPos(null);
        setLanding(false);
        return newField;
      }
    });
  }, [landing]);

  // 拡大倍率
  const SCALE = 1.4;
  const CELL_SIZE = 40 * SCALE;
  const FIELD_WIDTH = COLS * CELL_SIZE + 1;
  const FIELD_HEIGHT = ROWS * CELL_SIZE + 1;

  // 描画用フィールド（組ぷよを重ねて表示）
  const displayField = field.map(r => [...r]);
  return (
    <div className="puyo-main-layout" style={{display:'flex', alignItems:'flex-start', gap:'32px'}}>
      {/* 盤面エリア */}
      <div className="puyo-field" style={{position:'relative', width: FIELD_WIDTH, height: FIELD_HEIGHT, background:'#222', borderRadius:8, boxShadow:'0 2px 8px #0004', overflow:'hidden'}}>
        {/* 黄緑ライン */}
        <div style={{position:'absolute', left:0, top:(ROWS-12)*CELL_SIZE, width:COLS*CELL_SIZE+1, height:Math.max(4, Math.round(4*SCALE)), background:'#90ee90', zIndex:20}} />
        {/* 盤面セル（固定ぷよ）レイヤー */}
        <div className="puyo-board" style={{position:'absolute', top:0, left:0, width:COLS*CELL_SIZE+1, height:ROWS*CELL_SIZE+1, pointerEvents:'none', display:'flex', flexDirection:'column'}}>
          {displayField.map((row, rIdx) => (
            <div className="puyo-row" key={rIdx} style={{height:CELL_SIZE, display:'flex', flexDirection:'row'}}>
              {row.map((cell, cIdx) => {
                const isHighlight = highlightCells.includes(rIdx + ',' + cIdx);
                return (
                  <div
                    className={`puyo-cell${cell ? ' ' + cell : ''}${isHighlight ? ' highlight' : ''}`}
                    key={cIdx}
                    style={{width:CELL_SIZE, height:CELL_SIZE, display:'flex', alignItems:'center', justifyContent:'center'}}
                  >
                    {cell && <div className="puyo" style={{width:CELL_SIZE-8, height:CELL_SIZE-8, margin:4}} />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {/* 組ぷよ（落下中ぷよ）レイヤー */}
        <div className="puyo-active-layer" style={{position:'absolute', top:0, left:0, width:COLS*CELL_SIZE+1, height:ROWS*CELL_SIZE+1, pointerEvents:'none'}}>
          {!gameOver && !erasing && pair && pairPos && (() => {
            const BORDER_OFFSET = 2;
            const { fallY, col, rotation } = pairPos;
            const curPair = pair;
            const mainRow = Math.floor(fallY / 2);
            const drawCol = Math.round(col);
            const dir = DIRS[rotation];
            const subRow = Math.floor((fallY + dir.dr * 2) / 2);
            const subCol = drawCol + dir.dc;
            return <>
              {/* 下側ぷよ */}
              {mainRow >= -1 && mainRow < ROWS && drawCol >= 0 && drawCol < COLS && (
                <div
                  className={`puyo-cell puyo-floating ${curPair[1]}`}
                  style={{
                    position: 'absolute',
                    left: `${drawCol * CELL_SIZE + BORDER_OFFSET}px`,
                    top: `${mainRow * CELL_SIZE + BORDER_OFFSET + ((fallY % 2) * (CELL_SIZE / 2))}px`,
                    width: CELL_SIZE,
                    height: CELL_SIZE,
                    zIndex: 10,
                    display:'flex', alignItems:'center', justifyContent:'center'
                  }}
                >
                  <div className="puyo" style={{width:CELL_SIZE-8, height:CELL_SIZE-8, margin:4}} />
                </div>
              )}
              {/* 上側ぷよ */}
              {subRow >= -1 && subRow < ROWS && subCol >= 0 && subCol < COLS && (
                <div
                  className={`puyo-cell puyo-floating ${curPair[0]}`}
                  style={{
                    position: 'absolute',
                    left: `${subCol * CELL_SIZE + BORDER_OFFSET}px`,
                    top: `${subRow * CELL_SIZE + BORDER_OFFSET + (((fallY + dir.dr * 2) % 2) * (CELL_SIZE / 2))}px`,
                    width: CELL_SIZE,
                    height: CELL_SIZE,
                    zIndex: 10,
                    display:'flex', alignItems:'center', justifyContent:'center'
                  }}
                >
                  <div className="puyo" style={{width:CELL_SIZE-8, height:CELL_SIZE-8, margin:4}} />
                </div>
              )}
            </>;
          })()}
        </div>
      </div>
      {/* サイドバー */}
      <div className="puyo-sidebar" style={{minWidth:260, marginLeft:8, display:'flex', flexDirection:'column', gap:'24px'}}>
        <h1 style={{marginTop:0, fontSize:'2.2em', color:'#4ad'}}>ぷよ練</h1>
        <div style={{fontSize:'1.1em'}}>
          <b>フェーズ:</b> {gameOver ? 'gameover' : erasing ? 'erasing' : landing ? 'landing' : pair ? 'fall' : 'waiting'}<br/>
          <b>組ぷよ連番:</b> {pairSeqRef.current}<br/>
          <b>着地カウント:</b> {landWait} / 4<br/>
          <b>速度:</b> {speed}
        </div>
        {gameOver && <div style={{color:'red',fontWeight:'bold',fontSize:'2em'}}>ゲームオーバー</div>}
      </div>
    </div>
  );
}

export default App;
