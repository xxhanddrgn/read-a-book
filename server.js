/* =========================================================
 * 우리 반 책장 — 백엔드 (Express + SQLite)
 *
 * 환경변수:
 *   PORT            - 기본 3000 (Railway가 자동 주입)
 *   DATA_DIR        - 기본 ./data. Railway에선 /data (Volume) 권장
 *   APP_SECRET      - 비밀번호 해싱 솔트. 운영시 반드시 변경.
 *   TEACHER_CODE    - 교사 등록용 가입 코드. 기본 0000.
 *   ADMIN_NAME      - 관리자 로그인 이름. 기본 admin.
 *   ADMIN_PASSWORD  - 관리자 로그인 비밀번호. 기본 admin123. 운영시 반드시 변경.
 * ========================================================= */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const APP_SECRET = process.env.APP_SECRET || 'wb-bookshelf-default-secret-please-change';
const TEACHER_CODE = process.env.TEACHER_CODE || '0000';
const ADMIN_NAME = process.env.ADMIN_NAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
if (TEACHER_CODE === '0000') {
  console.warn('⚠️  TEACHER_CODE 가 기본값(0000)입니다. 운영 시 반드시 변경하세요.');
}
if (ADMIN_PASSWORD === 'admin123') {
  console.warn('⚠️  ADMIN_PASSWORD 가 기본값(admin123)입니다. 운영 시 ADMIN_PASSWORD 환경변수로 반드시 변경하세요.');
}

// ---------- DB 초기화 ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'bookshelf.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    grade INTEGER DEFAULT 0,
    classNo INTEGER DEFAULT 0,
    number INTEGER DEFAULT 0,
    isTeacher INTEGER NOT NULL DEFAULT 0,
    passwordHash TEXT NOT NULL,
    token TEXT,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    target TEXT NOT NULL CHECK (target IN ('teacher','student')),
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    review TEXT NOT NULL,
    question TEXT NOT NULL,
    images TEXT NOT NULL,
    authorKey TEXT NOT NULL,
    authorName TEXT NOT NULL,
    authorIsTeacher INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_posts_target ON posts(target, createdAt);

  CREATE TABLE IF NOT EXISTS likes (
    postId TEXT NOT NULL,
    userKey TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    PRIMARY KEY (postId, userKey),
    FOREIGN KEY (postId) REFERENCES posts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    postId TEXT NOT NULL,
    text TEXT NOT NULL,
    authorKey TEXT NOT NULL,
    authorName TEXT NOT NULL,
    isTeacher INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'general',
    createdAt INTEGER NOT NULL,
    FOREIGN KEY (postId) REFERENCES posts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_comments_postId ON comments(postId, createdAt);
`);

// 기존 DB에 category 컬럼이 없으면 추가 (마이그레이션)
const commentCols = db.prepare("PRAGMA table_info(comments)").all().map(c => c.name);
if (!commentCols.includes('category')) {
  db.exec("ALTER TABLE comments ADD COLUMN category TEXT NOT NULL DEFAULT 'general'");
}
if (!commentCols.includes('image')) {
  db.exec("ALTER TABLE comments ADD COLUMN image TEXT");
}
if (!commentCols.includes('parentId')) {
  db.exec("ALTER TABLE comments ADD COLUMN parentId TEXT");
}

// 기존 DB에 isAdmin 컬럼이 없으면 추가
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('isAdmin')) {
  db.exec("ALTER TABLE users ADD COLUMN isAdmin INTEGER NOT NULL DEFAULT 0");
}
// 보너스/조정 컬럼 — 관리자가 학생 활동량을 직접 가감
if (!userCols.includes('bonusPosts')) {
  db.exec("ALTER TABLE users ADD COLUMN bonusPosts INTEGER NOT NULL DEFAULT 0");
}
if (!userCols.includes('bonusComments')) {
  db.exec("ALTER TABLE users ADD COLUMN bonusComments INTEGER NOT NULL DEFAULT 0");
}
if (!userCols.includes('bonusLikes')) {
  db.exec("ALTER TABLE users ADD COLUMN bonusLikes INTEGER NOT NULL DEFAULT 0");
}

// 앱 설정 테이블 (책플루언서 초기화 시점 등)
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);
const getSetting = (k) => {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  return r ? r.value : null;
};
const setSetting = (k, v) => {
  db.prepare(
    'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(k, v == null ? null : String(v));
};

// ---------- 유틸 ----------
// 학생 소감 분량: 띄어쓰기·문장부호·이모지 등 모두 빼고 한글/영문/숫자만 카운트
const countContentChars = (s) =>
  String(s || '').replace(/[^\p{L}\p{N}]/gu, '').length;

const uid = () =>
  Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const hashPw = (pw) =>
  crypto.createHmac('sha256', APP_SECRET).update(String(pw)).digest('hex');

const userKey = ({ grade, classNo, number, name, isTeacher, isAdmin }) =>
  isAdmin
    ? `A-${name.trim()}`
    : isTeacher
    ? `T-${name.trim()}`
    : `${grade}-${classNo}-${number}-${name.trim()}`;

const isGuestKey = (k) => typeof k === 'string' && k.startsWith('GUEST-');

const toUserDTO = (u) => ({
  key: u.key,
  name: u.name,
  grade: u.grade,
  classNo: u.classNo,
  number: u.number,
  isTeacher: !!u.isTeacher,
  isAdmin: !!u.isAdmin,
  isGuest: isGuestKey(u.key),
});

// ---------- 앱 ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

// 헬스체크
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

// 인증 미들웨어
const authStmt = db.prepare('SELECT * FROM users WHERE token = ?');
function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다.' });
  const u = authStmt.get(token);
  if (!u) return res.status(401).json({ error: '세션이 만료되었습니다. 다시 로그인해주세요.' });
  req.user = u;
  next();
}

// 게스트는 쓰기 작업 금지
function blockGuest(req, res, next) {
  if (isGuestKey(req.user?.key)) {
    return res.status(403).json({
      error: '둘러보기 모드에서는 글·좋아요·댓글을 남길 수 없어요. 로그인 후 이용해 주세요!',
    });
  }
  next();
}

// 관리자 전용 미들웨어
function adminRequired(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
  }
  next();
}

// ---------- 인증 ----------
app.post('/api/auth/login', (req, res) => {
  try {
    const {
      grade, classNo, number, name, password,
      isTeacher = false, teacherCode = '',
      isAdmin = false,
    } = req.body || {};
    const teacher = !!isTeacher;
    const admin = !!isAdmin;
    const cleanName = String(name || '').trim();
    const pw = String(password || '');

    if (!cleanName) return res.status(400).json({ error: '이름을 입력해주세요.' });

    // ----- 관리자: 가입 코드 없이 ADMIN_NAME / ADMIN_PASSWORD 로 고정 로그인 -----
    if (admin) {
      if (cleanName !== ADMIN_NAME || pw !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: '관리자 이름 또는 비밀번호가 올바르지 않습니다.' });
      }
      const key = userKey({ name: cleanName, isAdmin: true });
      const ph = hashPw(pw);
      const now = Date.now();
      let row = db.prepare('SELECT * FROM users WHERE key = ?').get(key);
      if (!row) {
        db.prepare(
          `INSERT INTO users (key,name,grade,classNo,number,isTeacher,isAdmin,passwordHash,createdAt)
           VALUES (?,?,?,?,?,?,?,?,?)`
        ).run(key, cleanName, 0, 0, 0, 0, 1, ph, now);
        row = db.prepare('SELECT * FROM users WHERE key = ?').get(key);
      } else if (row.passwordHash !== ph) {
        // ADMIN_PASSWORD 가 환경변수로 바뀐 경우 해시 동기화
        db.prepare('UPDATE users SET passwordHash = ?, isAdmin = 1 WHERE key = ?').run(ph, key);
        row = db.prepare('SELECT * FROM users WHERE key = ?').get(key);
      }
      const token = newToken();
      db.prepare('UPDATE users SET token = ? WHERE key = ?').run(token, key);
      return res.json({ token, user: toUserDTO(row) });
    }

    // ----- 학생/교사: 4자리 비밀번호 -----
    if (pw.length !== 4) return res.status(400).json({ error: '비밀번호는 4글자여야 합니다.' });
    if (!teacher) {
      if (!Number.isFinite(+grade) || !Number.isFinite(+classNo) || !Number.isFinite(+number))
        return res.status(400).json({ error: '학년/반/번호를 입력해주세요.' });
    }

    const u = {
      grade: +grade || 0, classNo: +classNo || 0, number: +number || 0,
      name: cleanName, isTeacher: teacher,
    };
    const key = userKey(u);
    const ph = hashPw(pw);
    const now = Date.now();

    let row = db.prepare('SELECT * FROM users WHERE key = ?').get(key);
    if (row) {
      if (row.passwordHash !== ph) {
        return res.status(401).json({ error: '비밀번호가 달라요. 다시 확인해주세요.' });
      }
    } else {
      // 신규 가입
      if (teacher && String(teacherCode) !== TEACHER_CODE) {
        return res.status(403).json({ error: '교사 가입 코드가 올바르지 않습니다.' });
      }
      db.prepare(
        `INSERT INTO users (key,name,grade,classNo,number,isTeacher,isAdmin,passwordHash,createdAt)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(
        key, u.name, u.grade, u.classNo, u.number,
        teacher ? 1 : 0, 0, ph, now
      );
      row = db.prepare('SELECT * FROM users WHERE key = ?').get(key);
    }

    const token = newToken();
    db.prepare('UPDATE users SET token = ? WHERE key = ?').run(token, key);
    res.json({ token, user: toUserDTO(row) });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 게스트 (둘러보기) — 비밀번호 없이 단기 토큰 발급. 24시간 지난 게스트는 정리.
app.post('/api/auth/guest', (_req, res) => {
  try {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    db.prepare("DELETE FROM users WHERE key LIKE 'GUEST-%' AND createdAt < ?").run(dayAgo);
    const id = crypto.randomBytes(6).toString('hex');
    const key = `GUEST-${Date.now().toString(36)}-${id}`;
    const token = newToken();
    const now = Date.now();
    db.prepare(
      `INSERT INTO users (key,name,grade,classNo,number,isTeacher,passwordHash,token,createdAt)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(key, '게스트', 0, 0, 0, 0, crypto.randomBytes(32).toString('hex'), token, now);
    const row = db.prepare('SELECT * FROM users WHERE key = ?').get(key);
    res.json({ token, user: toUserDTO(row) });
  } catch (err) {
    console.error('guest error:', err);
    res.status(500).json({ error: '게스트 입장 실패' });
  }
});

app.post('/api/auth/logout', authRequired, (req, res) => {
  // 게스트가 로그아웃하면 흔적 자체를 지움
  if (isGuestKey(req.user.key)) {
    db.prepare('DELETE FROM users WHERE key = ?').run(req.user.key);
  } else {
    db.prepare('UPDATE users SET token = NULL WHERE key = ?').run(req.user.key);
  }
  res.json({ ok: true });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  res.json({ user: toUserDTO(req.user) });
});

// ---------- 게시글 ----------
const buildPostsResponse = () => {
  const posts = db
    .prepare('SELECT * FROM posts ORDER BY createdAt DESC')
    .all();
  const likeStmt = db.prepare('SELECT userKey FROM likes WHERE postId = ?');
  const commentStmt = db.prepare(
    'SELECT * FROM comments WHERE postId = ? ORDER BY createdAt ASC'
  );
  const enriched = posts.map((p) => ({
    id: p.id,
    target: p.target,
    title: p.title,
    author: p.author,
    review: p.review,
    question: p.question,
    images: JSON.parse(p.images),
    createdAt: p.createdAt,
    authorInfo: {
      key: p.authorKey,
      name: p.authorName,
      isTeacher: !!p.authorIsTeacher,
    },
    likes: likeStmt.all(p.id).map((r) => r.userKey),
    comments: commentStmt.all(p.id).map((c) => ({
      id: c.id,
      postId: c.postId,
      text: c.text,
      image: c.image || null,
      authorKey: c.authorKey,
      authorName: c.authorName,
      isTeacher: !!c.isTeacher,
      category: c.category || 'general',
      parentId: c.parentId || null,
      createdAt: c.createdAt,
    })),
  }));
  return {
    teacherPosts: enriched.filter((p) => p.target === 'teacher'),
    studentPosts: enriched.filter((p) => p.target === 'student'),
    rankingResetAt: Number(getSetting('ranking_reset_at')) || 0,
    userBonuses: buildBonusMap(),
  };
};

const buildBonusMap = () => {
  const out = {};
  db.prepare(
    `SELECT key, bonusPosts, bonusComments, bonusLikes FROM users
       WHERE bonusPosts != 0 OR bonusComments != 0 OR bonusLikes != 0`
  )
    .all()
    .forEach((r) => {
      out[r.key] = {
        posts: r.bonusPosts || 0,
        comments: r.bonusComments || 0,
        likes: r.bonusLikes || 0,
      };
    });
  return out;
};

app.get('/api/state', authRequired, (_req, res) => {
  res.json(buildPostsResponse());
});

app.post('/api/posts', authRequired, blockGuest, (req, res) => {
  try {
    const { target, title, author, review, question, images } = req.body || {};
    const t = target === 'teacher' ? 'teacher' : 'student';
    if (t === 'teacher' && !req.user.isTeacher) {
      return res.status(403).json({ error: '교사만 등록할 수 있습니다.' });
    }
    if (!Array.isArray(images) || images.length < 1) {
      return res.status(400).json({ error: '책 표지 이미지를 1장 이상 올려주세요.' });
    }
    if (images.length > 4) images.length = 4;
    if (!title?.trim() || !author?.trim() || !review?.trim()) {
      return res.status(400).json({ error: '필수 항목을 모두 입력해주세요.' });
    }
    // 학생 게시글에서만 질문이 필수, 교사 게시글은 질문 없이도 허용
    if (t === 'student' && !question?.trim()) {
      return res.status(400).json({ error: '책에 대한 질문을 입력해주세요.' });
    }
    // 학생 소감은 띄어쓰기·문장부호 제외 50자 이상
    if (t === 'student') {
      const reviewLen = countContentChars(review);
      if (reviewLen < 50) {
        return res.status(400).json({
          error: `소감을 띄어쓰기·문장부호 빼고 50자 이상 적어주세요. (현재 ${reviewLen}자)`,
        });
      }
    }
    const id = uid();
    db.prepare(
      `INSERT INTO posts (id,target,title,author,review,question,images,authorKey,authorName,authorIsTeacher,createdAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, t,
      String(title).trim().slice(0, 100),
      String(author).trim().slice(0, 60),
      String(review).trim().slice(0, 1500),
      String(question).trim().slice(0, 400),
      JSON.stringify(images),
      req.user.key,
      req.user.name,
      req.user.isTeacher ? 1 : 0,
      Date.now()
    );
    res.json({ id });
  } catch (err) {
    console.error('create post error:', err);
    res.status(500).json({ error: '게시글 저장 실패' });
  }
});

app.delete('/api/posts/:id', authRequired, blockGuest, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });
  if (post.authorKey !== req.user.key && !req.user.isTeacher && !req.user.isAdmin) {
    return res.status(403).json({ error: '본인 글만 지울 수 있습니다.' });
  }
  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// 게시글 수정 — 본인/교사/관리자
app.put('/api/posts/:id', authRequired, blockGuest, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });
  if (post.authorKey !== req.user.key && !req.user.isTeacher && !req.user.isAdmin) {
    return res.status(403).json({ error: '본인 글만 수정할 수 있습니다.' });
  }
  const { title, author, review, question } = req.body || {};
  const next = {
    title: String(title ?? post.title).trim().slice(0, 100),
    author: String(author ?? post.author).trim().slice(0, 60),
    review: String(review ?? post.review).trim().slice(0, 1500),
    question: String(question ?? post.question).trim().slice(0, 400),
  };
  if (!next.title || !next.author || !next.review) {
    return res.status(400).json({ error: '제목/지은이/본문은 비울 수 없습니다.' });
  }
  // 학생 게시글은 50자 룰 그대로 적용
  if (post.target === 'student') {
    const reviewLen = countContentChars(next.review);
    if (reviewLen < 50) {
      return res.status(400).json({
        error: `소감을 띄어쓰기·문장부호 빼고 50자 이상 적어주세요. (현재 ${reviewLen}자)`,
      });
    }
    if (!next.question) {
      return res.status(400).json({ error: '책에 대한 질문을 입력해주세요.' });
    }
  }
  db.prepare(
    'UPDATE posts SET title=?, author=?, review=?, question=? WHERE id=?'
  ).run(next.title, next.author, next.review, next.question, req.params.id);
  res.json({ ok: true });
});

// 좋아요 토글
app.post('/api/posts/:id/like', authRequired, blockGuest, (req, res) => {
  const post = db.prepare('SELECT 1 FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });
  const exists = db
    .prepare('SELECT 1 FROM likes WHERE postId = ? AND userKey = ?')
    .get(req.params.id, req.user.key);
  if (exists) {
    db.prepare('DELETE FROM likes WHERE postId = ? AND userKey = ?').run(
      req.params.id, req.user.key
    );
    return res.json({ liked: false });
  }
  db.prepare(
    'INSERT INTO likes (postId, userKey, createdAt) VALUES (?,?,?)'
  ).run(req.params.id, req.user.key, Date.now());
  res.json({ liked: true });
});

// 댓글 추가
const VALID_CATEGORIES = new Set(['general', 'review', 'question']);
app.post('/api/posts/:id/comments', authRequired, blockGuest, (req, res) => {
  const text = String(req.body?.text || '').trim();
  const image = req.body?.image ? String(req.body.image) : null;
  if (!text && !image) {
    return res.status(400).json({ error: '댓글 내용 또는 이미지를 첨부해주세요.' });
  }
  if (text.length > 400) return res.status(400).json({ error: '너무 긴 댓글은 줄여주세요.' });
  if (image && !/^data:image\/(png|jpe?g|gif|webp);base64,/.test(image)) {
    return res.status(400).json({ error: '이미지 형식이 올바르지 않습니다.' });
  }
  const rawCat = String(req.body?.category || 'general');
  const category = VALID_CATEGORIES.has(rawCat) ? rawCat : 'general';
  const parentIdRaw = req.body?.parentId ? String(req.body.parentId) : null;

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });

  // 학생 게시글: 'general'(친구들의 포스트잇) 또는 'question'(질문하기) 모두 허용
  // 교사 게시글: 'review' / 'question' 탭 그대로
  let finalCat;
  if (post.target === 'teacher') {
    finalCat = category === 'review' || category === 'question' ? category : 'review';
  } else {
    finalCat = category === 'question' ? 'question' : 'general';
  }

  // 대댓글(parentId) 검증 — 같은 게시글의 댓글이어야 함. 답글은 질문 담벼락에서만 허용.
  let parentId = null;
  if (parentIdRaw) {
    const parent = db
      .prepare('SELECT id, postId, category, parentId FROM comments WHERE id = ?')
      .get(parentIdRaw);
    if (!parent || parent.postId !== req.params.id) {
      return res.status(400).json({ error: '대상 댓글을 찾을 수 없습니다.' });
    }
    if (parent.category !== 'question') {
      return res.status(400).json({ error: '답글은 질문하기 담벼락에서만 달 수 있어요.' });
    }
    // 2단 이상 중첩 방지 — 답글의 답글은 같은 질문에 묶임
    parentId = parent.parentId || parent.id;
    finalCat = 'question';
  }

  // 1인 1포스트잇 제한 (학생 게시글의 최상위 댓글, 'general' / 'question' 모두)
  // 답글(parentId 있음)은 자유롭게 작성 가능.
  if (
    post.target === 'student' &&
    !parentId &&
    (finalCat === 'general' || finalCat === 'question')
  ) {
    const existing = db
      .prepare(
        `SELECT 1 FROM comments
           WHERE postId = ?
             AND category = ?
             AND (parentId IS NULL OR parentId = '')
             AND authorKey = ?`
      )
      .get(req.params.id, finalCat, req.user.key);
    if (existing) {
      const where = finalCat === 'general' ? '생각 나누기' : '질문 나누기';
      return res.status(400).json({
        error: `${where}는 한 사람당 한 개만 올릴 수 있어요.`,
      });
    }
  }

  // 선생님 '우리 반 온 책 읽기' 게시글의 소감 나누기 — 띄어쓰기·문장부호 제외 50자 이상
  if (finalCat === 'review' && !parentId) {
    const len = countContentChars(text);
    if (len < 50) {
      return res.status(400).json({
        error: `소감을 띄어쓰기·문장부호 빼고 50자 이상 적어주세요. (현재 ${len}자)`,
      });
    }
  }

  const cid = uid();
  db.prepare(
    `INSERT INTO comments (id,postId,text,authorKey,authorName,isTeacher,category,image,parentId,createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    cid, req.params.id, text,
    req.user.key, req.user.name,
    req.user.isTeacher ? 1 : 0, finalCat, image, parentId, Date.now()
  );
  res.json({ id: cid });
});

app.delete('/api/posts/:id/comments/:cid', authRequired, blockGuest, (req, res) => {
  const c = db
    .prepare('SELECT * FROM comments WHERE id = ? AND postId = ?')
    .get(req.params.cid, req.params.id);
  if (!c) return res.status(404).json({ error: '댓글을 찾을 수 없습니다.' });
  if (c.authorKey !== req.user.key && !req.user.isTeacher && !req.user.isAdmin) {
    return res.status(403).json({ error: '본인 댓글만 지울 수 있습니다.' });
  }
  db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.cid);
  res.json({ ok: true });
});

// 댓글 수정 — 본인/교사/관리자
app.put('/api/posts/:id/comments/:cid', authRequired, blockGuest, (req, res) => {
  const c = db
    .prepare('SELECT * FROM comments WHERE id = ? AND postId = ?')
    .get(req.params.cid, req.params.id);
  if (!c) return res.status(404).json({ error: '댓글을 찾을 수 없습니다.' });
  if (c.authorKey !== req.user.key && !req.user.isTeacher && !req.user.isAdmin) {
    return res.status(403).json({ error: '본인 댓글만 수정할 수 있습니다.' });
  }
  const text = String(req.body?.text || '').trim();
  if (text.length > 400) return res.status(400).json({ error: '너무 긴 댓글은 줄여주세요.' });
  if (!text && !c.image) {
    return res.status(400).json({ error: '내용을 입력해주세요.' });
  }
  // 소감 나누기 댓글은 50자 룰 유지
  if (c.category === 'review' && !c.parentId) {
    const len = countContentChars(text);
    if (len < 50) {
      return res.status(400).json({
        error: `소감을 띄어쓰기·문장부호 빼고 50자 이상 적어주세요. (현재 ${len}자)`,
      });
    }
  }
  db.prepare('UPDATE comments SET text = ? WHERE id = ?').run(text, req.params.cid);
  res.json({ ok: true });
});

// 알 수 없는 API 경로는 JSON 404
// ---------- 관리자 ----------
// 모든 사용자 목록 (게스트 제외)
app.get('/api/admin/users', authRequired, adminRequired, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT key, name, grade, classNo, number, isTeacher, isAdmin,
              bonusPosts, bonusComments, bonusLikes, createdAt
         FROM users
        WHERE key NOT LIKE 'GUEST-%'
        ORDER BY isAdmin DESC, isTeacher DESC, grade, classNo, number, name`
    )
    .all();
  res.json({
    users: rows.map((u) => ({
      key: u.key,
      name: u.name,
      grade: u.grade,
      classNo: u.classNo,
      number: u.number,
      isTeacher: !!u.isTeacher,
      isAdmin: !!u.isAdmin,
      bonusPosts: u.bonusPosts || 0,
      bonusComments: u.bonusComments || 0,
      bonusLikes: u.bonusLikes || 0,
      createdAt: u.createdAt,
    })),
  });
});

// 학생 활동량 보너스/조정 — posts/comments/likes 별로 ±정수
app.post('/api/admin/users/bonus', authRequired, adminRequired, (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: '대상 사용자가 필요합니다.' });
  const target = db.prepare('SELECT key FROM users WHERE key = ?').get(key);
  if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  const clamp = (n) => {
    const v = Math.trunc(Number(n));
    if (!Number.isFinite(v)) return 0;
    return Math.max(-9999, Math.min(9999, v));
  };
  const p = clamp(req.body?.posts ?? 0);
  const c = clamp(req.body?.comments ?? 0);
  const l = clamp(req.body?.likes ?? 0);
  db.prepare(
    'UPDATE users SET bonusPosts = ?, bonusComments = ?, bonusLikes = ? WHERE key = ?'
  ).run(p, c, l, key);
  res.json({ ok: true, bonusPosts: p, bonusComments: c, bonusLikes: l });
});

// 사용자 비밀번호 재설정
app.post('/api/admin/users/password', authRequired, adminRequired, (req, res) => {
  const { key, password } = req.body || {};
  const pw = String(password || '');
  if (!key || pw.length !== 4) {
    return res.status(400).json({ error: '대상 사용자와 4글자 비밀번호가 필요합니다.' });
  }
  const target = db.prepare('SELECT key FROM users WHERE key = ?').get(key);
  if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  // 비번 재설정 시 해당 사용자의 토큰을 무효화하여 강제 재로그인
  db.prepare('UPDATE users SET passwordHash = ?, token = NULL WHERE key = ?')
    .run(hashPw(pw), key);
  res.json({ ok: true });
});

// 사용자 삭제
app.delete('/api/admin/users/:key', authRequired, adminRequired, (req, res) => {
  if (req.params.key === req.user.key) {
    return res.status(400).json({ error: '본인 계정은 삭제할 수 없습니다.' });
  }
  const r = db.prepare('DELETE FROM users WHERE key = ?').run(req.params.key);
  if (r.changes === 0) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  res.json({ ok: true });
});

// 모든 게시글 초기화
app.post('/api/admin/posts/reset-all', authRequired, adminRequired, (_req, res) => {
  const tx = db.transaction(() => {
    db.exec('DELETE FROM comments');
    db.exec('DELETE FROM likes');
    db.exec('DELETE FROM posts');
  });
  tx();
  res.json({ ok: true });
});

// 책플루언서(랭킹) 점수 초기화 — 이 시점 이후의 게시글/댓글만 점수에 반영
app.post('/api/admin/ranking/reset', authRequired, adminRequired, (_req, res) => {
  setSetting('ranking_reset_at', Date.now());
  res.json({ ok: true, rankingResetAt: Number(getSetting('ranking_reset_at')) });
});

// 초기화 취소 — ranking_reset_at 을 0 으로 되돌려 모든 활동을 다시 점수에 반영
app.post('/api/admin/ranking/clear-reset', authRequired, adminRequired, (_req, res) => {
  setSetting('ranking_reset_at', '0');
  res.json({ ok: true, rankingResetAt: 0 });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API not found' }));

// ---------- 정적 파일 ----------
// 자주 업데이트되는 학급용 SPA: HTML/JS/CSS 모두 매번 ETag 로 검증해
// 새 배포 직후에도 학생들이 옛 코드에 갇히지 않도록 한다.
// (이미지/폰트는 max-age 짧게)
app.use(
  express.static(__dirname, {
    extensions: ['html'],
    etag: true,
    lastModified: true,
    setHeaders(res, p) {
      if (/\.(html|js|css)$/.test(p)) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=600');
      }
    },
  })
);
// SPA 폴백 (그 외 GET은 모두 index.html)
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 에러 핸들러
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: '이미지가 너무 커요. 더 작은 이미지를 올려주세요.' });
  }
  console.error('unhandled:', err);
  res.status(500).json({ error: '서버 오류' });
});

app.listen(PORT, HOST, () => {
  console.log(`📚 우리 반 책장 listening on http://${HOST}:${PORT}`);
  console.log(`   DATA_DIR=${DATA_DIR}`);
});
