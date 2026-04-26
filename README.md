# 📚 우리 반 책장

학급 독서기록 및 독서감상 공유 플랫폼입니다. 별도의 서버 없이 정적 파일로 동작하며, 데이터는 브라우저의 `localStorage`에 저장됩니다. PC/크롬북(가로 16:9)과 모바일에 모두 대응합니다.

## 빠르게 실행하기 (로컬)

```bash
# 의존성 없음 — Node 18 이상이면 바로 실행
npm start
# 또는
node server.js
```

브라우저에서 `http://localhost:3000` 으로 접속합니다.

> 한 학급에서 함께 사용하려면, 한 PC(또는 학급 공유 컴퓨터)를 띄워두고 학생들이 그 화면을 사용하거나, 서버 호스팅(예: GitHub Pages, Netlify, Railway)을 통해 같은 도메인에서 접속하도록 하세요. **`localStorage`는 브라우저별로 저장되기 때문에**, 배포해도 학생마다 자기 기기의 데이터만 보입니다. 학급 단위로 데이터를 공유하려면 한 컴퓨터를 키오스크처럼 운영하거나, 별도의 백엔드(서버 + DB)를 추가해야 합니다.

## Railway 배포

이 저장소에는 Railway에서 바로 동작하는 설정이 들어 있습니다.

- `server.js`: 의존성 없는 Node 정적 파일 서버 (`process.env.PORT` 자동 사용)
- `package.json`: `npm start` 진입점
- `railway.json`: 빌더(NIXPACKS), 시작 명령, 헬스체크(`/healthz`) 설정

**배포 절차**

1. [railway.app](https://railway.app) 로그인 → **New Project** → **Deploy from GitHub repo**
2. 이 저장소(`read-a-book`)와 `claude/book-sharing-platform-zO24g` 브랜치 선택
3. Railway가 자동으로 Node 환경을 감지하고 `npm start`로 띄움
4. **Settings → Networking → Generate Domain** 에서 공개 URL 발급
5. 발급된 `*.up.railway.app` URL 로 접속

문제 진단:
- 빌드 로그에서 Node 버전이 18 이상인지 확인 (`engines` 필드로 지정됨)
- `https://<도메인>/healthz` 가 `ok` 를 반환하면 정상

## 기능

- **로그인**: 학년/반/번호/이름 + 4글자 비밀번호. 처음 로그인한 비밀번호로 자동 등록됩니다.
- **교사 로그인**: 로그인 화면 하단의 **👩‍🏫 교사 로그인** 버튼. 최초 1회 비밀번호를 등록한 뒤, 다음부터는 같은 비밀번호로 로그인합니다.
- **우리 반 온 책 읽기**: 상단 가로 스크롤. 교사만 글을 올릴 수 있습니다.
- **학생 게시글**: 정방형 카드로 왼쪽 상단부터 자동 배치됩니다.
- **글쓰기 필수 항목**: 책 표지 이미지(1장 이상), 제목, 지은이, 소감문, 질문 1개.
- **좋아요**: 카드의 하트를 바로 누를 수 있고, 카드에 좋아요 수와 댓글 수가 함께 표시됩니다.
- **상세 페이지**: 책 정보 + 작성자 소감 + 질문, 그리고 친구들이 **포스트잇 담벼락**에 소감/질문을 붙입니다.
- **우리 반 책플루언서**: 상단 배너에서 1위 표시, 클릭 시 TOP 10 랭킹. 점수 = 게시글 수 + (댓글 수 ÷ 3).
- **반응형**: 768px 이하 화면에서는 모바일 레이아웃으로 자동 전환됩니다.
- **친숙한 디자인**: Google Fonts의 `Jua`, `Gaegu`, `Nanum Pen Script`를 사용한 따뜻한 톤의 UI.

## 데이터 초기화

저장된 글/사용자 정보를 모두 비우려면 브라우저 콘솔에서:

```js
localStorage.clear();
```

## 파일 구조

```
.
├── index.html       # 화면 구조
├── styles.css       # 디자인/반응형
├── app.js           # 로그인, 게시글, 좋아요, 댓글, 랭킹 로직
├── server.js        # Node 정적 서버 (Railway/로컬 공통)
├── package.json     # npm start 진입점
├── railway.json     # Railway 빌드/헬스체크 설정
└── README.md
```
