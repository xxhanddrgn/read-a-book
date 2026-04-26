# 📚 우리 반 책장

학급 독서기록 및 독서감상 공유 플랫폼입니다. **Express + SQLite** 백엔드를 통해 학급 전체가 동일한 데이터를 공유합니다. PC/크롬북(가로 16:9)과 모바일 모두 대응합니다.

## 빠르게 실행하기 (로컬)

```bash
npm install
npm start
```

브라우저에서 `http://localhost:3000` 으로 접속합니다.
데이터는 `./data/bookshelf.db` (SQLite)에 저장됩니다.

기본 환경변수는 다음과 같습니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | 리스닝 포트 (Railway가 자동 주입) |
| `DATA_DIR` | `./data` | SQLite 파일이 저장될 디렉터리. 운영시 영구 볼륨 권장 |
| `APP_SECRET` | (기본값) | 비밀번호 해시용 솔트. 배포 시 임의 문자열로 반드시 변경 |
| `TEACHER_CODE` | `0000` | 교사 신규 등록용 가입 코드. **반드시 변경하세요** |

## Railway 배포

### 1) 새 프로젝트 만들기
1. [railway.app](https://railway.app) 로그인 → **New Project** → **Deploy from GitHub repo**
2. 이 저장소(`read-a-book`)와 브랜치 `claude/book-sharing-platform-0BEaK` 선택
3. Railway가 `package.json` 을 감지해 NIXPACKS 빌드 → `npm start` 자동 실행

### 2) 영구 저장소 (Volume) 연결 — **중요**
SQLite 파일이 재배포 시 사라지지 않도록 Volume을 붙여야 합니다.

1. 서비스 → **Settings → Volumes → New Volume**
2. **Mount path**: `/data`
3. (선택) Size 1GB 정도면 충분
4. **Variables** 탭에서 다음 환경변수를 추가:
   - `DATA_DIR` = `/data`
   - `APP_SECRET` = (임의 32자 이상 문자열)
   - `TEACHER_CODE` = (선생님만 아는 6~8자리 코드)

### 3) 도메인 발급
- **Settings → Networking → Generate Domain** 클릭
- 발급된 `https://*.up.railway.app` 로 학급 학생들에게 공유

### 4) 배포 검증
- `https://<도메인>/healthz` → `ok`
- 로그인 → 게시글 작성 → 다른 기기에서 같은 글이 보이는지 확인

## 기능

- **로그인**: 학년/반/번호/이름 + 4글자 비밀번호. 첫 로그인 시 자동 가입.
- **교사 로그인**: 로그인 화면 하단의 **👩‍🏫 교사 로그인**. 최초 등록 시 `TEACHER_CODE` 가 필요. 같은 이름·비밀번호로 다시 로그인.
- **우리 반 온 책 읽기**: 상단 가로 스크롤. 교사만 등록 가능.
- **학생 게시글**: 정방형 카드, 왼쪽 상단부터 자동 배치.
- **글쓰기 필수 항목**: 표지 이미지(1장 이상, 최대 4장 자동 압축), 제목, 지은이, 소감문, 질문.
- **좋아요**: 카드에서 하트 바로 누름. 좋아요/댓글 수 카드에 표시.
- **상세 페이지**: 책 정보 + 작성자 소감 + 질문 + 포스트잇 담벼락 댓글.
- **우리 반 책플루언서**: 상단 배너에 1위 표시, 클릭 시 TOP 10. 점수 = 게시글 수 + (댓글 수 ÷ 3).
- **자동 동기화**: 8초마다 폴링 + 탭 활성화 시 즉시 새로고침. 한 학생이 글을 올리면 다른 학생 화면에도 곧 반영됩니다.
- **반응형**: 768px 이하에서 모바일 레이아웃으로 자동 전환.

## API (참고)

| Method | Path | 설명 |
|---|---|---|
| `POST` | `/api/auth/login` | 로그인/자동가입 |
| `POST` | `/api/auth/logout` | 로그아웃 |
| `GET`  | `/api/auth/me` | 현재 사용자 |
| `GET`  | `/api/state` | 모든 게시글/댓글/좋아요 |
| `POST` | `/api/posts` | 게시글 작성 |
| `DELETE` | `/api/posts/:id` | 게시글 삭제 |
| `POST` | `/api/posts/:id/like` | 좋아요 토글 |
| `POST` | `/api/posts/:id/comments` | 댓글 작성 |
| `DELETE` | `/api/posts/:id/comments/:cid` | 댓글 삭제 |
| `GET`  | `/healthz` | 헬스체크 |

모든 `/api/*` 엔드포인트는 `Authorization: Bearer <token>` 필요 (로그인 제외).

## 데이터 초기화

```bash
# 로컬
rm -rf data/

# Railway
# 서비스 → Settings → Volumes → 마운트된 볼륨 삭제 후 재배포
```

## 파일 구조

```
.
├── index.html       # 화면 구조
├── styles.css       # 디자인/반응형
├── app.js           # 프론트엔드 (API 호출 + 렌더 + 폴링)
├── server.js        # Express + SQLite 백엔드
├── package.json     # 의존성/스크립트
├── railway.json     # Railway 빌드/헬스체크 설정
└── README.md
```
