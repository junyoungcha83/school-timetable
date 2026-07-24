# school-timetable

두 자녀(승호/승아)의 주간 시간표 PWA. 월–토 일정을 항목·내용·시작/종료·장소·메모로 입력하고 색상이 적용된 격자 시간표로 시각화.

## 구조

```
school-timetable/
├── index.html
├── manifest.webmanifest
├── sw.js
├── assets/{app.js, app.css, icon.svg, icon-maskable.svg}
├── data/default.json        # 첫 실행 fallback (빈 상태)
└── api/                     # Cloudflare Worker — 데이터 동기화 API
    ├── src/index.js
    ├── package.json
    └── wrangler.toml
```

## 로컬 실행

```sh
python3 -m http.server 8000
open http://localhost:8000/
```

## 데이터 모델

```json
{
  "version": 1,
  "entries": [
    {
      "id": "e1",
      "child": "seungho",
      "day": "mon",
      "kind": "school",
      "content": "수학",
      "start": "09:00",
      "end": "10:00",
      "place": "강남구 ...",
      "memo": "준비물 ...",
      "color": "#fde68a"
    }
  ]
}
```

- `child`: `seungho` | `seunga`
- `day`: `mon|tue|wed|thu|fri|sat`
- `kind`: `school|kindergarten|academy`
- `color`: 8색 팔레트 중 하나

## Worker 배포

```sh
cd api
npx wrangler kv:namespace create TIMETABLE
# 출력 id 를 wrangler.toml 에 채워넣기
npx wrangler secret put EDIT_TOKEN
# 편집 비밀번호 입력
npx wrangler deploy
```

배포 후 출력된 workers.dev URL 을 `assets/app.js` 의 `API_BASE` 에 반영.

## 편집 권한

기본은 읽기 전용. 헤더의 `🔒` 버튼을 눌러 `EDIT_TOKEN` 비밀번호를 입력하면 편집 모드로 전환. 잘못된 토큰으로 PUT 하면 401 → 로컬 토큰 제거 후 자동 잠금.
