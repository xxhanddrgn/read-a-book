/* =========================================================
 * 우리 반 책장 — 프론트엔드 (백엔드 API 기반)
 * 데이터는 서버(SQLite)에 저장되어 학급 전체가 공유합니다.
 * ========================================================= */
(() => {
  'use strict';

  const SESSION_KEY = 'wb_session_v2';
  const ANON_KEY = 'wb_anon_mode';
  const POLL_MS = 8000;

  // -------- 상태 --------
  let session = null; // { token, user }
  let state = { teacherPosts: [], studentPosts: [] };
  let currentDetailId = null;
  let detailTab = 'review'; // 'review' | 'question' (교사 게시글 상세에서만 사용)
  let pollTimer = null;
  let anonMode = localStorage.getItem(ANON_KEY) === '1';
  const aliasMap = new Map(); // authorKey → '학생 N'

  // -------- 유틸 --------
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const escapeHtml = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const userKey = (u) =>
    u.isTeacher ? `T-${u.name}` : `${u.grade}-${u.classNo}-${u.number}-${u.name}`;

  const userLabel = (u) =>
    u.isGuest
      ? '👀 게스트'
      : u.isAdmin
      ? `🛡 ${u.name} (관리자)`
      : u.isTeacher
      ? `👩‍🏫 ${u.name} 선생님`
      : `${u.grade}-${u.classNo} ${u.number}번 ${u.name}`;

  // -------- 익명 모드 (교사/관리자 전용) --------
  const showAnon = () =>
    !!(session?.user?.isTeacher || session?.user?.isAdmin) && anonMode;

  const buildAliasMap = () => {
    aliasMap.clear();
    const seen = new Set();
    state.studentPosts.forEach((p) => {
      if (!p.authorInfo.isTeacher) seen.add(p.authorInfo.key);
      p.comments.forEach((c) => {
        if (!c.isTeacher) seen.add(c.authorKey);
      });
    });
    state.teacherPosts.forEach((p) => {
      p.comments.forEach((c) => {
        if (!c.isTeacher) seen.add(c.authorKey);
      });
    });
    Array.from(seen)
      .sort()
      .forEach((k, i) => aliasMap.set(k, `학생 ${i + 1}`));
  };

  // info 형태: { key, name, isTeacher } 또는 { authorKey, authorName, isTeacher }
  const personDisplay = (info) => {
    const key = info.key ?? info.authorKey;
    const name = info.name ?? info.authorName;
    const isTeacher = !!info.isTeacher;
    if (isTeacher) return name;
    if (showAnon()) return aliasMap.get(key) || '익명 학생';
    return name;
  };

  const updateAnonButton = () => {
    const btn = $('#anon-toggle');
    const allowed = !!(session?.user?.isTeacher || session?.user?.isAdmin);
    btn.classList.toggle('hidden', !allowed);
    btn.classList.toggle('on', anonMode);
    btn.querySelector('.anon-icon').textContent = anonMode ? '🙉' : '🙈';
    btn.querySelector('.anon-state').textContent = anonMode ? '켜짐' : '꺼짐';
  };

  const toggleAnonMode = () => {
    anonMode = !anonMode;
    localStorage.setItem(ANON_KEY, anonMode ? '1' : '0');
    updateAnonButton();
    // 모든 화면 다시 그리기
    renderTeacherPosts();
    renderBoard();
    if (currentDetailId) renderDetail(currentDetailId);
    toast(anonMode ? '익명 모드 ON — 학생 정보를 가립니다 🙉' : '익명 모드 OFF — 학생 정보가 다시 보여요 🙈');
  };

  const toast = (msg, ms = 1800) => {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), ms);
  };

  // -------- API --------
  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      if (res.status === 401) {
        clearSession();
        showLogin();
      }
      throw new Error((data && data.error) || `요청 실패 (${res.status})`);
    }
    return data;
  }

  // -------- 세션 --------
  const loadSession = () => {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    try {
      session = JSON.parse(raw);
      return !!session?.token;
    } catch {
      return false;
    }
  };
  const saveSession = () => {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  };
  const clearSession = () => {
    session = null;
    saveSession();
    stopPolling();
  };

  // -------- 이미지 압축 --------
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
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  // -------- 화면 전환 --------
  const ALL_SCREENS = [
    '#login-screen',
    '#app-screen',
    '#detail-screen',
    '#ranking-screen',
    '#admin-screen',
  ];
  const showOnly = (id) => {
    ALL_SCREENS.forEach((s) =>
      $(s).classList.toggle('hidden', s !== id)
    );
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  const showLogin = () => {
    stopPolling();
    document.body.classList.remove('guest-mode');
    $('#guest-banner')?.classList.add('hidden');
    showOnly('#login-screen');
    currentDetailId = null;
  };
  const showApp = async () => {
    showOnly('#app-screen');
    currentDetailId = null;
    applyGuestMode();
    renderUserArea();
    await refreshState();
    startPolling();
  };
  const showDetailScreen = (id) => {
    currentDetailId = id;
    detailTab = 'review';
    const post = findPost(id);
    const titleEl = $('#detail-screen .page-topbar-title');
    if (titleEl) {
      titleEl.textContent =
        post && post.target === 'teacher' ? '📖 우리 반 온 책 읽기' : '📖 책 이야기';
    }
    renderDetail(id);
    showOnly('#detail-screen');
  };
  const showRankingScreen = () => {
    renderRanking();
    showOnly('#ranking-screen');
  };
  const showAdminScreen = async () => {
    if (!session?.user?.isAdmin) return toast('관리자만 접근할 수 있어요.');
    showOnly('#admin-screen');
    renderAdminInfo();
    await loadAdminUsers();
  };
  const backToApp = () => {
    currentDetailId = null;
    showOnly('#app-screen');
  };

  // -------- 로그인 / 로그아웃 --------
  async function onLoginSubmit(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const data = await api('POST', '/api/auth/login', {
        grade: Number(fd.get('grade')),
        classNo: Number(fd.get('classNo')),
        number: Number(fd.get('number')),
        name: String(fd.get('name')).trim(),
        password: String(fd.get('password')),
        isTeacher: false,
      });
      session = { token: data.token, user: data.user };
      saveSession();
      toast(`${data.user.name} 친구, 환영해요! 🎉`);
      showApp();
    } catch (err) {
      toast(err.message || '로그인 실패');
    }
  }

  async function onTeacherLogin() {
    const name = prompt('선생님 성함을 입력해주세요. (예: 김선생)');
    if (!name) return;
    const password = prompt('교사 비밀번호 4자리를 입력해주세요.');
    if (!password) return;
    if (password.length !== 4) {
      toast('비밀번호는 4자리예요.');
      return;
    }
    let teacherCode = '';
    try {
      // 처음에는 코드 없이 시도 (이미 등록된 교사인 경우 통과)
      const data = await api('POST', '/api/auth/login', {
        name: name.trim(),
        password,
        isTeacher: true,
      });
      session = { token: data.token, user: data.user };
      saveSession();
      toast(`${data.user.name} 선생님, 환영합니다! 👩‍🏫`);
      showApp();
      return;
    } catch (err) {
      // 신규 등록인 경우 가입 코드를 요구
      if (!/코드/.test(err.message)) {
        toast(err.message);
        return;
      }
    }
    teacherCode = prompt('교사 가입 코드를 입력해주세요. (관리자에게 문의)');
    if (!teacherCode) return;
    try {
      const data = await api('POST', '/api/auth/login', {
        name: name.trim(),
        password,
        isTeacher: true,
        teacherCode,
      });
      session = { token: data.token, user: data.user };
      saveSession();
      toast(`${data.user.name} 선생님, 환영합니다! 👩‍🏫`);
      showApp();
    } catch (err) {
      toast(err.message);
    }
  }

  async function onAdminLogin() {
    const name = prompt('관리자 이름을 입력해주세요.');
    if (!name) return;
    const password = prompt('관리자 비밀번호를 입력해주세요.');
    if (!password) return;
    try {
      const data = await api('POST', '/api/auth/login', {
        name: name.trim(),
        password,
        isAdmin: true,
      });
      session = { token: data.token, user: data.user };
      saveSession();
      toast(`${data.user.name} 관리자, 환영합니다! 🛡`);
      showApp();
    } catch (err) {
      toast(err.message);
    }
  }

  async function onGuestEnter() {
    try {
      const data = await api('POST', '/api/auth/guest', {});
      session = { token: data.token, user: data.user };
      saveSession();
      toast('둘러보기 모드로 들어왔어요 👀');
      showApp();
    } catch (err) {
      toast(err.message || '게스트 입장 실패');
    }
  }

  async function logout() {
    try { await api('POST', '/api/auth/logout'); } catch {}
    clearSession();
    showLogin();
  }

  const isGuest = () => !!session?.user?.isGuest;
  const applyGuestMode = () => {
    document.body.classList.toggle('guest-mode', isGuest());
    $('#guest-banner').classList.toggle('hidden', !isGuest());
  };

  // -------- 폴링 --------
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(refreshState, POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    document.removeEventListener('visibilitychange', onVisibility);
  }
  function onVisibility() {
    if (!document.hidden && session) refreshState();
  }

  async function refreshState() {
    if (!session) return;
    try {
      state = await api('GET', '/api/state');
      buildAliasMap();
      renderTeacherPosts();
      renderBoard();
      if (currentDetailId) renderDetail(currentDetailId);
    } catch (err) {
      // 401이면 위에서 이미 로그인 화면으로 보냄
      console.warn('refresh failed:', err.message);
    }
  }

  // -------- 게시글 --------
  let pendingCovers = [];

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
    const form = $('#new-post-form');
    form.reset();
    $('#new-post-title').textContent = forTeacher
      ? '📖 우리 반 온 책 읽기 등록'
      : '📕 새 책 올리기';
    form.dataset.target = forTeacher ? 'teacher' : 'student';

    // 교사/학생에 따라 필수 입력란을 토글
    form.querySelectorAll('.student-only').forEach((el) => {
      el.classList.toggle('hidden', forTeacher);
      el.querySelectorAll('textarea, input').forEach((i) => {
        i.required = !forTeacher;
        if (forTeacher) i.value = '';
      });
    });
    form.querySelectorAll('.teacher-only').forEach((el) => {
      el.classList.toggle('hidden', !forTeacher);
      el.querySelectorAll('textarea, input').forEach((i) => {
        i.required = forTeacher;
        if (!forTeacher) i.value = '';
      });
    });

    openModal('new-post-modal');
  };

  async function onSubmitPost(e) {
    e.preventDefault();
    if (!pendingCovers.length) {
      toast('책 표지 이미지를 1장 이상 올려주세요!');
      return;
    }
    const fd = new FormData(e.target);
    const target = e.target.dataset.target || 'student';
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const payload = {
        target,
        title: String(fd.get('title') || '').trim(),
        author: String(fd.get('author') || '').trim(),
        images: pendingCovers,
      };
      if (target === 'teacher') {
        payload.review = String(fd.get('teacherMessage') || '').trim();
        payload.question = ''; // 교사 게시글은 질문 없음
      } else {
        payload.review = String(fd.get('review') || '').trim();
        payload.question = String(fd.get('question') || '').trim();
      }
      await api('POST', '/api/posts', payload);
      closeModal('new-post-modal');
      toast('게시글이 올라갔어요! 📮');
      await refreshState();
    } catch (err) {
      toast(err.message);
    } finally {
      submitBtn.disabled = false;
    }
  }

  // -------- 좋아요 / 댓글 --------
  const guestBlockMsg = '둘러보기 모드에서는 사용할 수 없어요. 로그인 후 이용해 주세요!';

  async function toggleLike(postId) {
    if (isGuest()) return toast(guestBlockMsg);
    try {
      await api('POST', `/api/posts/${postId}/like`);
      await refreshState();
    } catch (err) {
      toast(err.message);
    }
  }

  async function addComment(postId, text, category = 'general') {
    if (isGuest()) return toast(guestBlockMsg);
    const t = (text || '').trim();
    if (!t) return;
    try {
      await api('POST', `/api/posts/${postId}/comments`, { text: t, category });
      await refreshState();
    } catch (err) {
      toast(err.message);
    }
  }

  async function deleteComment(postId, commentId) {
    try {
      await api('DELETE', `/api/posts/${postId}/comments/${commentId}`);
      await refreshState();
    } catch (err) {
      toast(err.message);
    }
  }

  async function deletePost(postId) {
    if (!confirm('이 게시글을 정말 지울까요?')) return;
    try {
      await api('DELETE', `/api/posts/${postId}`);
      backToApp();
      toast('게시글을 지웠어요.');
      await refreshState();
    } catch (err) {
      toast(err.message);
    }
  }

  // -------- 모달 --------
  const openModal = (id) => $('#' + id).classList.remove('hidden');
  const closeModal = (id) => $('#' + id).classList.add('hidden');

  // -------- 렌더 --------
  const renderUserArea = () => {
    if (!session) return;
    $('#who-am-i').textContent = userLabel(session.user);
    // 교사 또는 관리자만 우리 반 온 책 읽기 등록 가능
    $('#add-teacher-post-btn').classList.toggle(
      'hidden',
      !(session.user.isTeacher || session.user.isAdmin)
    );
    $('#open-admin-btn').classList.toggle('hidden', !session.user.isAdmin);
    updateAnonButton();
  };

  const findPost = (id) =>
    state.studentPosts.find((p) => p.id === id) ||
    state.teacherPosts.find((p) => p.id === id);

  const renderTeacherPosts = () => {
    const wrap = $('#teacher-posts');
    if (!state.teacherPosts.length) {
      wrap.innerHTML =
        '<div class="empty-ono">선생님이 함께 읽을 책을 곧 올려주실 거예요!</div>';
      return;
    }
    wrap.innerHTML = state.teacherPosts
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
    wrap.querySelectorAll('.ono-card').forEach((el) =>
      el.addEventListener('click', () => openDetail(el.dataset.id))
    );
  };

  const renderBoard = () => {
    const grid = $('#student-posts');
    const empty = $('#empty-board');
    if (!state.studentPosts.length) {
      grid.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    grid.innerHTML = state.studentPosts
      .map(
        (p) => `
        <article class="post-card" data-id="${p.id}">
          <div class="post-square">
            <img src="${p.images[0]}" alt="${escapeHtml(p.title)}" />
            <span class="author-tag">${escapeHtml(personDisplay(p.authorInfo))}</span>
            <div class="post-overlay">
              <h3 class="p-title">${escapeHtml(p.title)}</h3>
              <div class="p-author">✏ ${escapeHtml(p.author)}</div>
            </div>
          </div>
          <div class="post-meta">
            <span class="meta-likes">❤ ${p.likes.length}</span>
            <span class="meta-comments">💬 ${p.comments.length}</span>
          </div>
        </article>`
      )
      .join('');

    grid.querySelectorAll('.post-card').forEach((card) => {
      card.addEventListener('click', () => openDetail(card.dataset.id));
    });
  };

  // -------- 상세 --------
  const POSTIT_COLORS = [
    'var(--postit-yellow)',
    'var(--postit-pink)',
    'var(--postit-blue)',
    'var(--postit-green)',
    'var(--postit-purple)',
  ];

  const openDetail = (id) => showDetailScreen(id);

  const renderPostit = (c, i, me) => {
    const color = POSTIT_COLORS[i % POSTIT_COLORS.length];
    const tilt = ((i * 37) % 7) - 3;
    const canDelete = c.authorKey === me || session.user.isTeacher;
    const cName = personDisplay(c);
    return `
      <div class="postit" style="background:${color}; --tilt:${tilt}deg;">
        <div class="pt-text">${escapeHtml(c.text)}</div>
        <div class="pt-by">
          ${c.isTeacher ? '👩‍🏫 ' : '🌱 '}${escapeHtml(cName)}
          ${canDelete ? `<button class="link-btn" data-del-c="${c.id}" style="margin-left:6px;">지우기</button>` : ''}
        </div>
      </div>`;
  };

  const renderDetail = (id) => {
    const post = findPost(id);
    if (!post) return;
    const me = userKey(session.user);
    const liked = post.likes.includes(me);
    const isAdmin = !!session.user.isAdmin;
    const isMine = post.authorInfo.key === me || session.user.isTeacher || isAdmin;
    const isTeacherPost = post.target === 'teacher';

    const covers = post.images
      .map((src) => `<img src="${src}" alt="${escapeHtml(post.title)}" />`)
      .join('');

    const authorDisplay = personDisplay(post.authorInfo);

    // 본문 영역: 교사 게시글이면 탭 + 분리된 게시판, 학생이면 기존 담벼락
    let bodySection;
    if (isTeacherPost) {
      const reviewComments = post.comments.filter((c) => c.category === 'review');
      const questionComments = post.comments.filter((c) => c.category === 'question');
      const activeIsReview = detailTab !== 'question';

      const renderPanel = (cat, cs, emptyMsg) => {
        const grid = cs.length
          ? cs.map((c, i) => renderPostit(c, i, me)).join('')
          : `<div class="empty-wall">${emptyMsg}</div>`;
        const placeholder =
          cat === 'review'
            ? '이 책을 읽고 어떤 생각이 들었나요?'
            : '친구들과 함께 이야기 나누고 싶은 질문을 적어보세요!';
        const buttonLabel = cat === 'review' ? '💛 소감 올리기' : '❓ 질문 올리기';
        return `
          <div class="tab-panel ${cat === detailTab ? '' : 'hidden'}" data-panel="${cat}">
            <div class="postit-grid">${grid}</div>
            <form class="postit-form" data-comment="${post.id}" data-category="${cat}">
              <textarea required maxlength="400" placeholder="${placeholder}"></textarea>
              <button type="submit">${buttonLabel}</button>
            </form>
          </div>`;
      };

      bodySection = `
        <div class="detail-body">
          <h3>📢 선생님 말씀</h3>
          <div class="question-box"><div class="review">${escapeHtml(post.review)}</div></div>

          <div class="onm-tabs" role="tablist">
            <button class="onm-tab ${activeIsReview ? 'active' : ''}" data-tab="review" role="tab">
              💛 소감 나누기 <span class="tab-count">${reviewComments.length}</span>
            </button>
            <button class="onm-tab ${!activeIsReview ? 'active' : ''}" data-tab="question" role="tab">
              ❓ 질문 만들기 <span class="tab-count">${questionComments.length}</span>
            </button>
          </div>

          <div class="wall onm-wall">
            ${renderPanel('review', reviewComments, '아직 소감이 없어요. 첫 소감을 남겨볼까요? 💛')}
            ${renderPanel('question', questionComments, '아직 질문이 없어요. 궁금한 걸 적어볼까요? ❓')}
          </div>
        </div>`;
    } else {
      const postits = post.comments.length
        ? post.comments.map((c, i) => renderPostit(c, i, me)).join('')
        : '<div class="empty-wall">아직 댓글이 없어요. 첫 포스트잇을 붙여볼까요? 💛</div>';

      bodySection = `
        <div class="detail-body">
          <h3>📝 ${escapeHtml(authorDisplay)} 친구의 소감</h3>
          <div class="review">${escapeHtml(post.review)}</div>

          <h3>💭 함께 생각해볼 질문</h3>
          <div class="question-box"><div class="question">${escapeHtml(post.question)}</div></div>

          <h3>🧡 우리들의 담벼락</h3>
          <div class="wall">
            <h4 class="wall-title">친구들의 포스트잇 (${post.comments.length})</h4>
            <div class="postit-grid">${postits}</div>
            <form class="postit-form" data-comment="${post.id}" data-category="general">
              <textarea required maxlength="400" placeholder="포스트잇에 한마디 남겨보세요!"></textarea>
              <button type="submit">붙이기 📌</button>
            </form>
          </div>
        </div>`;
    }

    $('#detail-body').innerHTML = `
      <div class="detail-hero">
        <div class="cover-stack">${covers}</div>
        <div class="detail-info">
          <h2>${escapeHtml(post.title)}</h2>
          <p class="by">✏ ${escapeHtml(post.author)} · 올린이: ${
      post.authorInfo.isTeacher ? '👩‍🏫 ' : ''
    }${escapeHtml(authorDisplay)}</p>
          <div class="stats">
            <span class="like-stat">❤ ${post.likes.length}</span>
            <span>💬 ${post.comments.length}</span>
          </div>
          <div class="detail-actions">
            <button class="like-big ${liked ? 'liked' : ''}" data-like-detail="${post.id}">
              ${liked ? '❤️ 좋아요!' : '🤍 좋아요'}
            </button>
            ${isAdmin ? `<button class="edit-btn" data-edit-post="${post.id}">✏ 수정</button>` : ''}
            ${isMine ? `<button class="delete-btn" data-del-post="${post.id}">게시글 지우기</button>` : ''}
          </div>
        </div>
      </div>
      ${bodySection}
    `;

    $('#detail-body')
      .querySelector('[data-like-detail]')
      .addEventListener('click', (e) =>
        toggleLike(e.currentTarget.dataset.likeDetail)
      );

    const delBtn = $('#detail-body').querySelector('[data-del-post]');
    if (delBtn)
      delBtn.addEventListener('click', () =>
        deletePost(delBtn.dataset.delPost)
      );

    const editBtn = $('#detail-body').querySelector('[data-edit-post]');
    if (editBtn)
      editBtn.addEventListener('click', () => openEditPost(post));

    // 탭 전환 (교사 게시글 한정)
    $('#detail-body')
      .querySelectorAll('.onm-tab')
      .forEach((b) =>
        b.addEventListener('click', () => {
          detailTab = b.dataset.tab;
          renderDetail(id);
        })
      );

    // 댓글 작성 폼들 (탭별로 여러 개 있을 수 있음)
    $('#detail-body')
      .querySelectorAll('[data-comment]')
      .forEach((form) => {
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const ta = form.querySelector('textarea');
          const cat = form.dataset.category || 'general';
          addComment(form.dataset.comment, ta.value, cat);
          ta.value = '';
        });
      });

    $('#detail-body')
      .querySelectorAll('[data-del-c]')
      .forEach((b) =>
        b.addEventListener('click', () =>
          deleteComment(post.id, b.dataset.delC)
        )
      );
  };

  // -------- 책플루언서 (명예의 전당) --------
  const computeRanking = () => {
    const map = new Map();
    const since = Number(state.rankingResetAt) || 0;
    const bump = (k, name, isTeacher, dPosts, dComments) => {
      if (isTeacher) return;
      if (!map.has(k)) map.set(k, { key: k, name, posts: 0, comments: 0 });
      const o = map.get(k);
      o.posts += dPosts;
      o.comments += dComments;
    };
    state.studentPosts.forEach((p) => {
      if (p.createdAt >= since) {
        bump(p.authorInfo.key, p.authorInfo.name, p.authorInfo.isTeacher, 1, 0);
      }
      p.comments.forEach((c) => {
        if (c.createdAt >= since) {
          bump(c.authorKey, c.authorName, c.isTeacher, 0, 1);
        }
      });
    });
    state.teacherPosts.forEach((p) => {
      p.comments.forEach((c) => {
        if (c.createdAt >= since) {
          bump(c.authorKey, c.authorName, c.isTeacher, 0, 1);
        }
      });
    });
    // 게시글 수 우선, 동률이면 댓글 수, 그래도 동률이면 이름
    const list = Array.from(map.values());
    list.sort(
      (a, b) =>
        b.posts - a.posts ||
        b.comments - a.comments ||
        a.name.localeCompare(b.name, 'ko')
    );
    return list;
  };

  const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const podiumSpot = (rank, item) => {
    if (!item) {
      return `
        <div class="podium-spot empty rank-${rank}">
          <div class="podium-medal">${MEDAL[rank]}</div>
          <div class="podium-name">-</div>
          <div class="podium-stats">아직 없음</div>
        </div>`;
    }
    const name = personDisplay({ key: item.key, name: item.name, isTeacher: false });
    return `
      <div class="podium-spot rank-${rank}">
        <div class="podium-medal">${MEDAL[rank]}</div>
        <div class="podium-name">${escapeHtml(name)}</div>
        <div class="podium-stats">글 ${item.posts}개<br/>댓글 ${item.comments}개</div>
      </div>`;
  };

  const renderRanking = () => {
    const list = computeRanking();
    const podium = $('#ranking-podium');
    const ol = $('#ranking-list');

    if (!list.length) {
      podium.innerHTML = `
        <div class="podium-empty-block">
          <div class="podium-empty-icon">🏆</div>
          <div class="podium-empty-msg">아직 순위가 없어요</div>
          <div class="podium-empty-sub">첫 게시글의 주인공이 되어보세요!</div>
        </div>`;
      ol.innerHTML = '';
      return;
    }

    // 단상은 2위 - 1위 - 3위 순서로 배치
    podium.innerHTML =
      podiumSpot(2, list[1]) + podiumSpot(1, list[0]) + podiumSpot(3, list[2]);

    const rest = list.slice(3, 20);
    ol.innerHTML = rest
      .map((o, i) => {
        const name = personDisplay({ key: o.key, name: o.name, isTeacher: false });
        return `
        <li>
          <span class="rank-num">${i + 4}</span>
          <span class="rank-name">${escapeHtml(name)}</span>
          <span class="rank-stats">글 ${o.posts}개 · 댓글 ${o.comments}개</span>
        </li>`;
      })
      .join('');
  };

  // -------- 관리자 화면 --------
  let adminUsers = [];

  const renderAdminInfo = () => {
    const since = Number(state.rankingResetAt) || 0;
    const info = $('#admin-ranking-info');
    if (!info) return;
    info.textContent = since
      ? `최근 초기화: ${new Date(since).toLocaleString('ko-KR')}`
      : '아직 초기화한 적 없음 — 모든 기록이 점수에 반영됩니다.';
  };

  const userTagLabel = (u) => {
    if (u.isAdmin) return '🛡 관리자';
    if (u.isTeacher) return '👩‍🏫 교사';
    return `${u.grade}-${u.classNo} ${u.number}번`;
  };

  const renderAdminUsers = () => {
    const wrap = $('#admin-users');
    if (!wrap) return;
    if (!adminUsers.length) {
      wrap.innerHTML = '<div class="admin-empty">아직 등록된 사용자가 없어요.</div>';
      return;
    }
    wrap.innerHTML = adminUsers
      .map(
        (u) => `
        <div class="admin-user-row" data-key="${escapeHtml(u.key)}">
          <div class="admin-user-info">
            <span class="admin-user-tag">${escapeHtml(userTagLabel(u))}</span>
            <span class="admin-user-name">${escapeHtml(u.name)}</span>
          </div>
          <div class="admin-user-actions">
            <button class="btn-ghost" data-admin-pw="${escapeHtml(u.key)}">비번 재설정</button>
            ${u.key !== session.user.key
              ? `<button class="btn-danger-text" data-admin-del-user="${escapeHtml(u.key)}">계정 삭제</button>`
              : ''}
          </div>
        </div>`
      )
      .join('');

    wrap.querySelectorAll('[data-admin-pw]').forEach((b) =>
      b.addEventListener('click', () => onAdminResetPassword(b.dataset.adminPw))
    );
    wrap.querySelectorAll('[data-admin-del-user]').forEach((b) =>
      b.addEventListener('click', () => onAdminDeleteUser(b.dataset.adminDelUser))
    );
  };

  async function loadAdminUsers() {
    try {
      const data = await api('GET', '/api/admin/users');
      adminUsers = data.users || [];
      renderAdminUsers();
    } catch (err) {
      $('#admin-users').innerHTML = `<div class="admin-empty">${escapeHtml(err.message)}</div>`;
    }
  }

  async function onAdminResetRanking() {
    if (!confirm('우리 반 책플루언서 점수를 초기화할까요?\n(게시글은 그대로 남고, 이 시점 이후 활동만 점수에 반영됩니다.)')) return;
    try {
      await api('POST', '/api/admin/ranking/reset');
      toast('책플루언서 점수를 초기화했어요.');
      await refreshState();
      renderAdminInfo();
    } catch (err) {
      toast(err.message);
    }
  }

  async function onAdminResetAllPosts() {
    if (!confirm('정말로 모든 게시글·댓글·좋아요를 영구히 삭제할까요?\n되돌릴 수 없어요.')) return;
    if (!confirm('한 번 더 확인합니다. 정말 전체 삭제하시겠어요?')) return;
    try {
      await api('POST', '/api/admin/posts/reset-all');
      toast('모든 게시글을 삭제했어요.');
      await refreshState();
    } catch (err) {
      toast(err.message);
    }
  }

  async function onAdminResetPassword(key) {
    const pw = prompt('새 비밀번호 4자리를 입력하세요:');
    if (!pw) return;
    if (pw.length !== 4) return toast('4글자 비밀번호를 입력해주세요.');
    try {
      await api('POST', '/api/admin/users/password', { key, password: pw });
      toast('비밀번호를 변경했어요. 해당 사용자는 다시 로그인해야 합니다.');
    } catch (err) {
      toast(err.message);
    }
  }

  async function onAdminDeleteUser(key) {
    if (!confirm(`이 계정(${key})을 삭제할까요?\n해당 사용자가 작성한 게시글과 댓글은 그대로 남습니다.`)) return;
    try {
      await api('DELETE', `/api/admin/users/${encodeURIComponent(key)}`);
      toast('계정을 삭제했어요.');
      await loadAdminUsers();
    } catch (err) {
      toast(err.message);
    }
  }

  // -------- 게시글 수정 (관리자) --------
  const openEditPost = (post) => {
    const form = $('#edit-post-form');
    form.elements.id.value = post.id;
    form.elements.title.value = post.title;
    form.elements.author.value = post.author;
    form.elements.review.value = post.review;
    form.elements.question.value = post.question || '';
    // 교사 게시글은 질문 행 숨김
    $('#edit-question-row').classList.toggle('hidden', post.target === 'teacher');
    openModal('edit-post-modal');
  };

  async function onSubmitEditPost(e) {
    e.preventDefault();
    const form = e.target;
    const id = form.elements.id.value;
    const payload = {
      title: form.elements.title.value.trim(),
      author: form.elements.author.value.trim(),
      review: form.elements.review.value.trim(),
      question: form.elements.question.value.trim(),
    };
    try {
      await api('PUT', `/api/admin/posts/${encodeURIComponent(id)}`, payload);
      closeModal('edit-post-modal');
      toast('게시글을 수정했어요.');
      await refreshState();
    } catch (err) {
      toast(err.message);
    }
  }

  // -------- 이벤트 바인딩 --------
  const bind = () => {
    $('#login-form').addEventListener('submit', onLoginSubmit);
    $('#teacher-login-btn').addEventListener('click', onTeacherLogin);
    $('#admin-login-btn').addEventListener('click', onAdminLogin);
    $('#guest-login-btn').addEventListener('click', onGuestEnter);
    $('#guest-go-login').addEventListener('click', logout);
    $('#logout-btn').addEventListener('click', logout);

    $('#new-post-fab').addEventListener('click', () => openNewPost(false));
    $('#add-teacher-post-btn').addEventListener('click', () => openNewPost(true));
    $('#cover-input').addEventListener('change', onCoverChange);
    $('#new-post-form').addEventListener('submit', onSubmitPost);
    $('#edit-post-form').addEventListener('submit', onSubmitEditPost);

    $('#influencer-banner').addEventListener('click', () => showRankingScreen());
    $('#anon-toggle').addEventListener('click', toggleAnonMode);

    // 관리자 페이지
    $('#open-admin-btn').addEventListener('click', () => showAdminScreen());
    $('#admin-reset-ranking').addEventListener('click', onAdminResetRanking);
    $('#admin-reset-posts').addEventListener('click', onAdminResetAllPosts);
    $('#admin-go-board').addEventListener('click', () => backToApp());

    // 모달 닫기 (새 글 작성 모달은 그대로 모달 사용)
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-close]');
      if (t) closeModal(t.dataset.close);
      const back = e.target.closest('[data-back]');
      if (back) backToApp();
    });
    $$('.modal').forEach((m) =>
      m.addEventListener('click', (e) => {
        if (e.target === m) m.classList.add('hidden');
      })
    );
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // 1순위: 열린 모달이 있으면 모달부터 닫기
      const openedModal = $$('.modal').find((m) => !m.classList.contains('hidden'));
      if (openedModal) {
        openedModal.classList.add('hidden');
        return;
      }
      // 2순위: 상세/랭킹/관리자 페이지면 앱 화면으로 복귀
      if (
        !$('#detail-screen').classList.contains('hidden') ||
        !$('#ranking-screen').classList.contains('hidden') ||
        !$('#admin-screen').classList.contains('hidden')
      ) {
        backToApp();
      }
    });
  };

  // -------- 시작 --------
  bind();
  if (loadSession()) {
    showApp().catch(() => showLogin());
  } else {
    showLogin();
  }
})();
