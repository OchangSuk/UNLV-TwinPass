# UNLV TwinPass

카메라와 음성을 이용하는 멀티모달 출석 키오스크입니다. 영상과 음성 원본은 브라우저 또는 Edge 장치에서 처리하고, 서버에는 최종 판정과 출석 이벤트만 전송합니다.

## 사용자 흐름

1. `Start`를 누르면 카메라 캡처와 팀원 판별을 시작합니다.
2. 등록된 팀원이 확인되면 음성 단계로 이동합니다.
3. 녹음 버튼을 누르고 `hello`라고 말합니다.
4. 음성 검증에 성공하면 출석 이벤트와 사용자 프로필을 표시합니다.

등록 라벨은 `Sihoon`, `changsuk`, `Catherine`, `seoyeon`이며, 그 외 결과는 `OTHER`로 처리합니다. 기본 화면은 로그인 없이 사용할 수 있습니다.

## 로컬 실행

```powershell
npm.cmd install
npm.cmd run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)을 엽니다. 카메라와 마이크 권한을 허용해야 합니다.

실제 Edge Impulse 모델이 연결되지 않은 동안에는 화면의 `Demo settings`에서 사용자 라벨을 선택해 전체 흐름을 테스트할 수 있습니다. 카메라나 마이크가 없는 장치에서는 명시적인 데모 대체 동작을 사용할 수 있습니다.

## 로컬 추론 연결

웹 페이지는 실제 Vision/Audio 추론 구현을 다음 인터페이스로 연결할 수 있습니다.

```ts
window.twinpassInference = {
  identify: async ({ video }) => ({
    label: "Sihoon",
    confidence: 0.96,
  }),
  verifyHello: async ({ audio }) => ({
    verified: true,
    confidence: 0.93,
  }),
};
```

## Edge 장치 이벤트 API

`POST /api/v1/events`

```http
Authorization: Bearer <DEVICE_API_KEY>
Content-Type: application/json
```

```json
{
  "event_id": "8e1d7414-7328-4d67-8df4-10e587a9e201",
  "device_id": "NICLA-ENTRY-01",
  "person_id": "changsuk",
  "vision_verified": true,
  "voice_verified": true,
  "vision_confidence": 0.96,
  "voice_confidence": 0.93,
  "detected_at": "2026-08-11T16:00:00.000Z",
  "inference_ms": 684,
  "firmware_version": "0.1.0",
  "decision": "ACCEPT"
}
```

서버는 `person_id != OTHER && vision_verified && voice_verified`일 때만 승인합니다. 같은 `event_id`를 다시 보내도 중복 출석이 생성되지 않습니다.

로컬 가상 이벤트 전송 예시:

```powershell
npm.cmd run simulate -- changsuk
npm.cmd run simulate -- Sihoon reject
npm.cmd run simulate -- OTHER
```

## 환경 변수와 배포

`.env.example`을 `.env.local`로 복사해 개발 값을 설정합니다.

- `DEVICE_API_KEY`: Edge 장치 요청 인증 키
- `DATABASE_URL`: Neon Postgres 연결 문자열

Vercel에서는 GitHub 저장소를 연결하고 위 환경 변수를 등록합니다. Neon SQL Editor에서 `migrations/001_create_attendance_events.sql`을 한 번 실행해야 합니다. `DATABASE_URL`이 없으면 로컬 메모리 저장소를 사용하므로 서버 재시작 시 이벤트가 초기화됩니다.

## 검증

```powershell
npm.cmd run check
npx.cmd tsc --noEmit
```
