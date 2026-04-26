/* =========================================================
 * 우리 반 책장 — 백엔드 (Express + SQLite)
 *
 * 환경변수:
 *   PORT          - 기본 3000 (Railway가 자동 주입)
 *   DATA_DIR      - 기본 ./data. Railway에선 /data (Volume) 권장
 *   APP_SECRET    - 비밀번호 해싱 솔트. 운영시 반드시 변경.
 *   TEACHER_CODE  - 교사 등록용 가입 코드. 기본 0000.
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
if (TEACHER_CODE === '0000') {
  console.warn('⚠️  TEACHER_CODE 가 기본값(0000)입니다. 운영 시 반드시 변경하세요.');
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

// ---------- 유틸 ----------
const uid = () =>
  Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const hashPw = (pw) =>
  crypto.createHmac('sha256', APP_SECRET).update(String(pw)).digest('hex');

const userKey = ({ grade, classNo, number, name, isTeacher }) =>
  isTeacher
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

// ---------- 인증 ----------
app.post('/api/auth/login', (req, res) => {
  try {
    const {
      grade, classNo, number, name, password,
      isTeacher = false, teacherCode = '',
    } = req.body || {};
    const teacher = !!isTeacher;
    const cleanName = String(name || '').trim();
    const pw = String(password || '');

    if (!cleanName) return res.status(400).json({ error: '이름을 입력해주세요.' });
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
        `INSERT INTO users (key,name,grade,classNo,number,isTeacher,passwordHash,createdAt)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(key, u.name, u.grade, u.classNo, u.number, teacher ? 1 : 0, ph, now);
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
      text: c.text,
      authorKey: c.authorKey,
      authorName: c.authorName,
      isTeacher: !!c.isTeacher,
      category: c.category || 'general',
      createdAt: c.createdAt,
    })),
  }));
  return {
    teacherPosts: enriched.filter((p) => p.target === 'teacher'),
    studentPosts: enriched.filter((p) => p.target === 'student'),
  };
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
  if (post.authorKey !== req.user.key && !req.user.isTeacher) {
    return res.status(403).json({ error: '본인 글만 지울 수 있습니다.' });
  }
  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
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
  if (!text) return res.status(400).json({ error: '댓글 내용을 입력해주세요.' });
  if (text.length > 400) return res.status(400).json({ error: '너무 긴 댓글은 줄여주세요.' });
  const rawCat = String(req.body?.category || 'general');
  const category = VALID_CATEGORIES.has(rawCat) ? rawCat : 'general';

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: '게시글을 찾을 수 없습니다.' });
  // 학생 게시글에서는 category 무시하고 general로 저장
  const finalCat = post.target === 'teacher' ? category : 'general';
  const cid = uid();
  db.prepare(
    `INSERT INTO comments (id,postId,text,authorKey,authorName,isTeacher,category,createdAt)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    cid, req.params.id, text,
    req.user.key, req.user.name,
    req.user.isTeacher ? 1 : 0, finalCat, Date.now()
  );
  res.json({ id: cid });
});

app.delete('/api/posts/:id/comments/:cid', authRequired, blockGuest, (req, res) => {
  const c = db
    .prepare('SELECT * FROM comments WHERE id = ? AND postId = ?')
    .get(req.params.cid, req.params.id);
  if (!c) return res.status(404).json({ error: '댓글을 찾을 수 없습니다.' });
  if (c.authorKey !== req.user.key && !req.user.isTeacher) {
    return res.status(403).json({ error: '본인 댓글만 지울 수 있습니다.' });
  }
  db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.cid);
  res.json({ ok: true });
});

// 알 수 없는 API 경로는 JSON 404
app.use('/api', (_req, res) => res.status(404).json({ error: 'API not found' }));

// ---------- 정적 파일 ----------
app.use(
  express.static(__dirname, {
    extensions: ['html'],
    setHeaders(res, p) {
      if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      else res.setHeader('Cache-Control', 'public, max-age=300');
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
