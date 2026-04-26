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
    u.isTeacher ? `👩‍🏫 ${u.name} 선생님` : `${u.grade}-${u.classNo} ${u.number}번 ${u.name}`;

  // -------- 익명 모드 (교사 전용) --------
  const showAnon = () => !!session?.user?.isTeacher && anonMode;

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
    const isTeacher = !!session?.user?.isTeacher;
    btn.classList.toggle('hidden', !isTeacher);
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
    renderInfluencerBanner();
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
  const showLogin = () => {
    stopPolling();
    $('#login-screen').classList.remove('hidden');
    $('#app-screen').classList.add('hidden');
  };
  const showApp = async () => {
    $('#login-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');
    renderUserArea();
    await refreshState();
    startPolling();
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

  async function logout() {
    try { await api('POST', '/api/auth/logout'); } catch {}
    clearSession();
    showLogin();
  }

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
      renderInfluencerBanner();
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
    $('#new-post-form').reset();
    $('#new-post-title').textContent = forTeacher
      ? '📖 우리 반 온 책 읽기 등록'
      : '📕 새 책 올리기';
    $('#new-post-form').dataset.target = forTeacher ? 'teacher' : 'student';
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
      await api('POST', '/api/posts', {
        target,
        title: String(fd.get('title')).trim(),
        author: String(fd.get('author')).trim(),
        review: String(fd.get('review')).trim(),
        question: String(fd.get('question')).trim(),
        images: pendingCovers,
      });
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
  async function toggleLike(postId) {
    try {
      await api('POST', `/api/posts/${postId}/like`);
      await refreshState();
    } catch (err) {
      toast(err.message);
    }
  }

  async function addComment(postId, text) {
    const t = (text || '').trim();
    if (!t) return;
    try {
      await api('POST', `/api/posts/${postId}/comments`, { text: t });
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
      closeModal('detail-modal');
      currentDetailId = null;
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
    $('#add-teacher-post-btn').classList.toggle('hidden', !session.user.isTeacher);
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
    const me = userKey(session.user);
    grid.innerHTML = state.studentPosts
      .map((p) => {
        const liked = p.likes.includes(me);
        return `
        <article class="post-card" data-id="${p.id}">
          <div class="post-square">
            <img src="${p.images[0]}" alt="${escapeHtml(p.title)}" />
            <span class="author-tag">${escapeHtml(personDisplay(p.authorInfo))}</span>
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

  // -------- 상세 --------
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
    const me = userKey(session.user);
    const liked = post.likes.includes(me);
    const isMine = post.authorInfo.key === me || session.user.isTeacher;

    const covers = post.images
      .map((src) => `<img src="${src}" alt="${escapeHtml(post.title)}" />`)
      .join('');

    const postitsHtml = post.comments.length
      ? post.comments
          .map((c, i) => {
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
          })
          .join('')
      : '<div class="empty-wall">아직 댓글이 없어요. 첫 포스트잇을 붙여볼까요? 💛</div>';

    const authorDisplay = personDisplay(post.authorInfo);
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
            ${isMine ? `<button class="delete-btn" data-del-post="${post.id}">게시글 지우기</button>` : ''}
          </div>
        </div>
      </div>

      <div class="detail-body">
        <h3>📝 ${escapeHtml(authorDisplay)} 친구의 소감</h3>
        <div class="review">${escapeHtml(post.review)}</div>

        <h3>💭 함께 생각해볼 질문</h3>
        <div class="question-box"><div class="question">${escapeHtml(post.question)}</div></div>

        <h3>🧡 우리들의 담벼락</h3>
        <div class="wall">
          <h4 class="wall-title">친구들의 포스트잇 (${post.comments.length})</h4>
          <div class="postit-grid">${postitsHtml}</div>
          <form class="postit-form" data-comment="${post.id}">
            <textarea required maxlength="400" placeholder="포스트잇에 한마디 남겨보세요!"></textarea>
            <button type="submit">붙이기 📌</button>
          </form>
        </div>
      </div>
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

    const form = $('#detail-body').querySelector('[data-comment]');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const ta = form.querySelector('textarea');
      addComment(form.dataset.comment, ta.value);
      ta.value = '';
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
    const bump = (k, name, isTeacher, dPosts, dComments) => {
      if (isTeacher) return;
      if (!map.has(k)) map.set(k, { key: k, name, posts: 0, comments: 0 });
      const o = map.get(k);
      o.posts += dPosts;
      o.comments += dComments;
    };
    state.studentPosts.forEach((p) => {
      bump(p.authorInfo.key, p.authorInfo.name, p.authorInfo.isTeacher, 1, 0);
      p.comments.forEach((c) =>
        bump(c.authorKey, c.authorName, c.isTeacher, 0, 1)
      );
    });
    state.teacherPosts.forEach((p) => {
      p.comments.forEach((c) =>
        bump(c.authorKey, c.authorName, c.isTeacher, 0, 1)
      );
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

  const renderInfluencerBanner = () => {
    const leader = computeRanking()[0];
    $('#banner-leader').textContent = leader
      ? personDisplay({ key: leader.key, name: leader.name, isTeacher: false })
      : '아직 없음';
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
    $('#anon-toggle').addEventListener('click', toggleAnonMode);

    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-close]');
      if (t) closeModal(t.dataset.close);
    });
    $$('.modal').forEach((m) =>
      m.addEventListener('click', (e) => {
        if (e.target === m) m.classList.add('hidden');
      })
    );
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') $$('.modal').forEach((m) => m.classList.add('hidden'));
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
