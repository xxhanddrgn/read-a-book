/* =========================================================
 * 우리 반 책장 (Class Bookshelf)
 * 정적 SPA. 데이터는 localStorage에 저장됩니다.
 * ========================================================= */

(() => {
  'use strict';

  // -------- 저장소 키 --------
  const KEY = {
    USERS: 'wb_users_v1',           // { "1-2-14-홍길동": "1234" }
    SESSION: 'wb_session_v1',       // 현재 로그인 사용자
    TEACHER_POSTS: 'wb_teacher_posts_v1',
    STUDENT_POSTS: 'wb_student_posts_v1',
    TEACHER_PASS: 'wb_teacher_pass_v1', // 교사 비밀번호 (최초 등록)
  };

  // -------- 상태 --------
  let session = null;     // {grade, classNo, number, name, isTeacher}
  let users = {};
  let teacherPosts = [];
  let studentPosts = [];

  // -------- 유틸 --------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const uid = () =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const load = () => {
    users = JSON.parse(localStorage.getItem(KEY.USERS) || '{}');
    teacherPosts = JSON.parse(localStorage.getItem(KEY.TEACHER_POSTS) || '[]');
    studentPosts = JSON.parse(localStorage.getItem(KEY.STUDENT_POSTS) || '[]');
    const s = localStorage.getItem(KEY.SESSION);
    session = s ? JSON.parse(s) : null;
  };
  const saveUsers = () =>
    localStorage.setItem(KEY.USERS, JSON.stringify(users));
  const saveTeacherPosts = () =>
    localStorage.setItem(KEY.TEACHER_POSTS, JSON.stringify(teacherPosts));
  const saveStudentPosts = () =>
    localStorage.setItem(KEY.STUDENT_POSTS, JSON.stringify(studentPosts));
  const saveSession = () => {
    if (session) localStorage.setItem(KEY.SESSION, JSON.stringify(session));
    else localStorage.removeItem(KEY.SESSION);
  };

  const userKey = (u) =>
    `${u.grade}-${u.classNo}-${u.number}-${u.name.trim()}`;
  const userLabel = (u) =>
    u.isTeacher
      ? `👩‍🏫 ${u.name} 선생님`
      : `${u.grade}-${u.classNo} ${u.number}번 ${u.name}`;

  const escapeHtml = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const toast = (msg, ms = 1800) => {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), ms);
  };

  // 이미지 → 캔버스로 리사이즈하여 base64로 저장 (localStorage 용량 절약)
  const fileToCompressedDataURL = (file, maxSize = 900, quality = 0.82) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          const ratio = Math.min(maxSize / width, maxSize / height, 1);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  // -------- 화면 전환 --------
  const showLogin = () => {
    $('#login-screen').classList.remove('hidden');
    $('#app-screen').classList.add('hidden');
  };
  const showApp = () => {
    $('#login-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');
    renderAll();
  };

  // -------- 로그인 --------
  const onLoginSubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const grade = Number(fd.get('grade'));
    const classNo = Number(fd.get('classNo'));
    const number = Number(fd.get('number'));
    const name = String(fd.get('name')).trim();
    const password = String(fd.get('password')).trim();

    if (password.length !== 4) {
      toast('비밀번호는 4글자로 입력해주세요!');
      return;
    }
    const u = { grade, classNo, number, name, isTeacher: false };
    const key = userKey(u);
    const stored = users[key];
    if (stored && stored !== password) {
      toast('비밀번호가 달라요. 다시 확인해주세요.');
      return;
    }
    if (!stored) {
      users[key] = password;
      saveUsers();
    }
    session = u;
    saveSession();
    toast(`${name} 친구, 환영해요! 🎉`);
    showApp();
  };

  const onTeacherLogin = () => {
    const name = prompt('선생님 성함을 입력해주세요. (예: 김선생)');
    if (!name) return;
    const stored = localStorage.getItem(KEY.TEACHER_PASS);
    let pw;
    if (stored) {
      pw = prompt('교사 비밀번호 4자리를 입력해주세요.');
      if (!pw) return;
      if (pw !== stored) {
        toast('비밀번호가 달라요.');
        return;
      }
    } else {
      pw = prompt('교사 비밀번호를 처음 설정합니다. (4자리)');
      if (!pw || pw.length !== 4) {
        toast('4자리 비밀번호를 입력해주세요.');
        return;
      }
      localStorage.setItem(KEY.TEACHER_PASS, pw);
    }
    session = { grade: 0, classNo: 0, number: 0, name: name.trim(), isTeacher: true };
    saveSession();
    toast(`${session.name} 선생님, 환영합니다! 👩‍🏫`);
    showApp();
  };

  const logout = () => {
    session = null;
    saveSession();
    showLogin();
  };

  // -------- 모달 --------
  const openModal = (id) => $('#' + id).classList.remove('hidden');
  const closeModal = (id) => $('#' + id).classList.add('hidden');

  // -------- 글쓰기 --------
  let pendingCovers = []; // base64[]

  const onCoverChange = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    pendingCovers = [];
    const preview = $('#cover-preview');
    preview.innerHTML = '';
    for (const f of files.slice(0, 4)) {
      try {
        const dataURL = await fileToCompressedDataURL(f);
        pendingCovers.push(dataURL);
        const img = document.createElement('img');
        img.src = dataURL;
        preview.appendChild(img);
      } catch {
        toast('이미지를 불러오지 못했어요.');
      }
    }
  };

  const openNewPost = (forTeacher = false) => {
    pendingCovers = [];
    $('#cover-preview').innerHTML = '';
    $('#new-post-form').reset();
    $('#new-post-title').textContent = forTeacher
      ? '📖 우리 반 온 책 읽기 등록'
      : '📕 새 책 올리기';
    $('#new-post-form').dataset.target = forTeacher ? 'teacher' : 'student';
    openModal('new-post-modal');
  };

  const onSubmitPost = (e) => {
    e.preventDefault();
    if (!pendingCovers.length) {
      toast('책 표지 이미지를 1장 이상 올려주세요!');
      return;
    }
    const fd = new FormData(e.target);
    const target = e.target.dataset.target || 'student';
    const post = {
      id: uid(),
      target,
      images: pendingCovers.slice(),
      title: String(fd.get('title')).trim(),
      author: String(fd.get('author')).trim(),
      review: String(fd.get('review')).trim(),
      question: String(fd.get('question')).trim(),
      createdAt: Date.now(),
      authorInfo: {
        name: session.name,
        grade: session.grade,
        classNo: session.classNo,
        number: session.number,
        isTeacher: session.isTeacher,
        key: userKey(session),
      },
      likes: [],
      comments: [],
    };

    try {
      if (target === 'teacher') {
        teacherPosts.unshift(post);
        saveTeacherPosts();
      } else {
        studentPosts.unshift(post);
        saveStudentPosts();
      }
    } catch (err) {
      toast('저장 공간이 부족해요. 이미지를 더 작게 올려보세요.');
      return;
    }

    closeModal('new-post-modal');
    toast('게시글이 올라갔어요! 📮');
    renderAll();
  };

  // -------- 좋아요/댓글 --------
  const findPost = (id) => {
    return (
      studentPosts.find((p) => p.id === id) ||
      teacherPosts.find((p) => p.id === id)
    );
  };
  const persistFor = (post) => {
    if (post.target === 'teacher') saveTeacherPosts();
    else saveStudentPosts();
  };

  const toggleLike = (postId) => {
    const post = findPost(postId);
    if (!post) return;
    const me = userKey(session);
    const i = post.likes.indexOf(me);
    if (i >= 0) post.likes.splice(i, 1);
    else post.likes.push(me);
    persistFor(post);
    renderAll();
    // 상세가 열려있으면 다시 그림
    if (currentDetailId === postId) renderDetail(postId);
  };

  const addComment = (postId, text) => {
    const post = findPost(postId);
    if (!post) return;
    const t = text.trim();
    if (!t) return;
    post.comments.push({
      id: uid(),
      text: t,
      authorName: session.name,
      authorKey: userKey(session),
      isTeacher: session.isTeacher,
      createdAt: Date.now(),
    });
    persistFor(post);
    renderDetail(postId);
    renderBoard();
    renderInfluencerBanner();
  };

  const deleteComment = (postId, commentId) => {
    const post = findPost(postId);
    if (!post) return;
    const c = post.comments.find((x) => x.id === commentId);
    if (!c) return;
    if (c.authorKey !== userKey(session) && !session.isTeacher) {
      toast('자기가 쓴 글만 지울 수 있어요.');
      return;
    }
    post.comments = post.comments.filter((x) => x.id !== commentId);
    persistFor(post);
    renderDetail(postId);
    renderBoard();
    renderInfluencerBanner();
  };

  const deletePost = (postId) => {
    const post = findPost(postId);
    if (!post) return;
    if (post.authorInfo.key !== userKey(session) && !session.isTeacher) {
      toast('자기가 쓴 글만 지울 수 있어요.');
      return;
    }
    if (!confirm('이 게시글을 정말 지울까요?')) return;
    teacherPosts = teacherPosts.filter((p) => p.id !== postId);
    studentPosts = studentPosts.filter((p) => p.id !== postId);
    saveTeacherPosts();
    saveStudentPosts();
    closeModal('detail-modal');
    currentDetailId = null;
    renderAll();
    toast('게시글을 지웠어요.');
  };

  // -------- 렌더링 --------
  const renderUserArea = () => {
    $('#who-am-i').textContent = userLabel(session);
    $('#add-teacher-post-btn').classList.toggle('hidden', !session.isTeacher);
  };

  const renderTeacherPosts = () => {
    const wrap = $('#teacher-posts');
    if (!teacherPosts.length) {
      wrap.innerHTML =
        '<div class="empty-ono">선생님이 함께 읽을 책을 곧 올려주실 거예요!</div>';
      return;
    }
    wrap.innerHTML = teacherPosts
      .map(
        (p) => `
        <div class="ono-card" data-id="${p.id}">
          <span class="ono-tag">선생님</span>
          <img class="cover" src="${p.images[0]}" alt="${escapeHtml(p.title)}" />
          <div class="ono-title">${escapeHtml(p.title)}</div>
          <div class="ono-author">${escapeHtml(p.author)}</div>
        </div>`
      )
      .join('');
    wrap.querySelectorAll('.ono-card').forEach((el) => {
      el.addEventListener('click', () => openDetail(el.dataset.id));
    });
  };

  const renderBoard = () => {
    const grid = $('#student-posts');
    const empty = $('#empty-board');
    if (!studentPosts.length) {
      grid.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    const me = userKey(session);
    grid.innerHTML = studentPosts
      .map((p) => {
        const liked = p.likes.includes(me);
        return `
        <article class="post-card" data-id="${p.id}">
          <div class="post-square">
            <img src="${p.images[0]}" alt="${escapeHtml(p.title)}" />
            <span class="author-tag">${escapeHtml(p.authorInfo.name)}</span>
            <button class="like-btn ${liked ? 'liked' : ''}" data-like="${p.id}" aria-label="좋아요">
              <span>${liked ? '❤️' : '🤍'}</span>
              <span>${p.likes.length}</span>
            </button>
            <div class="post-overlay">
              <h3 class="p-title">${escapeHtml(p.title)}</h3>
              <div class="p-author">✏ ${escapeHtml(p.author)}</div>
            </div>
          </div>
          <div class="post-meta">
            <span class="meta-likes">❤ ${p.likes.length}</span>
            <span class="meta-comments">💬 ${p.comments.length}</span>
          </div>
        </article>`;
      })
      .join('');

    grid.querySelectorAll('.post-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-like]')) return;
        openDetail(card.dataset.id);
      });
    });
    grid.querySelectorAll('[data-like]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        btn.classList.add('bump');
        setTimeout(() => btn.classList.remove('bump'), 300);
        toggleLike(btn.dataset.like);
      });
    });
  };

  // -------- 게시글 상세 --------
  let currentDetailId = null;
  const POSTIT_COLORS = [
    'var(--postit-yellow)',
    'var(--postit-pink)',
    'var(--postit-blue)',
    'var(--postit-green)',
    'var(--postit-purple)',
  ];

  const openDetail = (id) => {
    currentDetailId = id;
    renderDetail(id);
    openModal('detail-modal');
  };

  const renderDetail = (id) => {
    const post = findPost(id);
    if (!post) return;
    const me = userKey(session);
    const liked = post.likes.includes(me);
    const isMine =
      post.authorInfo.key === me || session.isTeacher;

    const covers = post.images
      .map(
        (src) =>
          `<img src="${src}" alt="${escapeHtml(post.title)}" />`
      )
      .join('');

    const postitsHtml = post.comments.length
      ? post.comments
          .map((c, i) => {
            const color = POSTIT_COLORS[i % POSTIT_COLORS.length];
            const tilt = ((i * 37) % 7) - 3; // -3 ~ +3deg
            const canDelete =
              c.authorKey === me || session.isTeacher;
            return `
            <div class="postit" style="background:${color}; --tilt:${tilt}deg;">
              <div class="pt-text">${escapeHtml(c.text)}</div>
              <div class="pt-by">
                ${c.isTeacher ? '👩‍🏫 ' : '🌱 '}${escapeHtml(c.authorName)}
                ${canDelete ? `<button class="link-btn" data-del-c="${c.id}" style="margin-left:6px;">지우기</button>` : ''}
              </div>
            </div>`;
          })
          .join('')
      : '<div class="empty-wall">아직 댓글이 없어요. 첫 포스트잇을 붙여볼까요? 💛</div>';

    $('#detail-body').innerHTML = `
      <div class="detail-hero">
        <div class="cover-stack">${covers}</div>
        <div class="detail-info">
          <h2>${escapeHtml(post.title)}</h2>
          <p class="by">✏ ${escapeHtml(post.author)} · 올린이: ${
      post.authorInfo.isTeacher ? '👩‍🏫 ' : ''
    }${escapeHtml(post.authorInfo.name)}</p>
          <div class="stats">
            <span class="like-stat">❤ ${post.likes.length}</span>
            <span>💬 ${post.comments.length}</span>
          </div>
          <div class="detail-actions">
            <button class="like-big ${liked ? 'liked' : ''}" data-like-detail="${post.id}">
              ${liked ? '❤️ 좋아요!' : '🤍 좋아요'}
            </button>
            ${isMine ? `<button class="delete-btn" data-del-post="${post.id}">게시글 지우기</button>` : ''}
          </div>
        </div>
      </div>

      <div class="detail-body">
        <h3>📝 ${escapeHtml(post.authorInfo.name)} 친구의 소감</h3>
        <div class="review">${escapeHtml(post.review)}</div>

        <h3>💭 함께 생각해볼 질문</h3>
        <div class="question-box"><div class="question">${escapeHtml(post.question)}</div></div>

        <h3>🧡 우리들의 담벼락</h3>
        <div class="wall">
          <h4 class="wall-title">친구들의 포스트잇 (${post.comments.length})</h4>
          <div class="postit-grid">${postitsHtml}</div>
          <form class="postit-form" data-comment="${post.id}">
            <textarea required maxlength="300" placeholder="포스트잇에 한마디 남겨보세요!"></textarea>
            <button type="submit">붙이기 📌</button>
          </form>
        </div>
      </div>
    `;

    // 이벤트
    $('#detail-body')
      .querySelector('[data-like-detail]')
      .addEventListener('click', (e) => toggleLike(e.currentTarget.dataset.likeDetail));

    const delBtn = $('#detail-body').querySelector('[data-del-post]');
    if (delBtn)
      delBtn.addEventListener('click', () => deletePost(delBtn.dataset.delPost));

    const form = $('#detail-body').querySelector('[data-comment]');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const t = form.querySelector('textarea').value;
      addComment(form.dataset.comment, t);
    });

    $('#detail-body')
      .querySelectorAll('[data-del-c]')
      .forEach((b) =>
        b.addEventListener('click', () =>
          deleteComment(post.id, b.dataset.delC)
        )
      );
  };

  // -------- 책플루언서 --------
  const computeRanking = () => {
    const map = new Map(); // key -> {name, posts, comments}
    const bump = (k, name, isTeacher, dPosts, dComments) => {
      if (isTeacher) return; // 학생만 랭킹에 포함
      if (!map.has(k))
        map.set(k, { key: k, name, posts: 0, comments: 0 });
      const o = map.get(k);
      o.posts += dPosts;
      o.comments += dComments;
    };
    studentPosts.forEach((p) => {
      bump(p.authorInfo.key, p.authorInfo.name, p.authorInfo.isTeacher, 1, 0);
      p.comments.forEach((c) =>
        bump(c.authorKey, c.authorName, c.isTeacher, 0, 1)
      );
    });
    teacherPosts.forEach((p) => {
      p.comments.forEach((c) =>
        bump(c.authorKey, c.authorName, c.isTeacher, 0, 1)
      );
    });
    const list = Array.from(map.values()).map((o) => ({
      ...o,
      score: o.posts + o.comments / 3,
    }));
    list.sort((a, b) => b.score - a.score || b.posts - a.posts);
    return list;
  };

  const renderInfluencerBanner = () => {
    const list = computeRanking();
    const leader = list[0];
    $('#banner-leader').textContent = leader
      ? `${leader.name} (${leader.score.toFixed(1)}점)`
      : '아직 없음';
  };

  const renderRanking = () => {
    const list = computeRanking().slice(0, 10);
    const ol = $('#ranking-list');
    if (!list.length) {
      ol.innerHTML =
        '<li>아직 게시글이 없어요. 첫 글을 올려보세요!</li>';
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    ol.innerHTML = list
      .map((o, i) => {
        const num = medals[i] || `${i + 1}.`;
        return `<li>
            <span><span class="rank-num">${num}</span> ${escapeHtml(o.name)}</span>
            <span class="rank-score">${o.score.toFixed(1)}점 · 글 ${o.posts}개 · 댓글 ${o.comments}개</span>
          </li>`;
      })
      .join('');
  };

  // -------- 전체 렌더 --------
  const renderAll = () => {
    if (!session) return;
    renderUserArea();
    renderTeacherPosts();
    renderBoard();
    renderInfluencerBanner();
  };

  // -------- 이벤트 바인딩 --------
  const bind = () => {
    $('#login-form').addEventListener('submit', onLoginSubmit);
    $('#teacher-login-btn').addEventListener('click', onTeacherLogin);
    $('#logout-btn').addEventListener('click', logout);

    $('#new-post-fab').addEventListener('click', () => openNewPost(false));
    $('#add-teacher-post-btn').addEventListener('click', () => openNewPost(true));

    $('#cover-input').addEventListener('change', onCoverChange);
    $('#new-post-form').addEventListener('submit', onSubmitPost);

    $('#influencer-banner').addEventListener('click', () => {
      renderRanking();
      openModal('ranking-modal');
    });

    // 모달 닫기 (X 또는 취소 버튼들)
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-close]');
      if (t) closeModal(t.dataset.close);
    });
    // 배경 클릭 닫기
    $$('.modal').forEach((m) => {
      m.addEventListener('click', (e) => {
        if (e.target === m) m.classList.add('hidden');
      });
    });
    // ESC
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') $$('.modal').forEach((m) => m.classList.add('hidden'));
    });
  };

  // -------- 시작 --------
  load();
  bind();
  if (session) showApp();
  else showLogin();
})();
