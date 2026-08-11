"use client";

import { useEffect, useRef, useState } from "react";
import { personIds } from "@/lib/domain";
import { teamProfiles, type RegisteredPersonId } from "@/lib/people";

type Phase = "IDLE" | "CAMERA" | "VISION" | "AUDIO_READY" | "RECORDING" | "VOICE" | "SUCCESS" | "REJECTED" | "ERROR";
type PersonId = (typeof personIds)[number];

declare global {
  interface Window {
    twinpassInference?: {
      identify(frame: ImageData): Promise<{ person_id: PersonId; confidence: number }>;
      verifyHello(audio: Blob, personId: RegisteredPersonId): Promise<{ verified: boolean; confidence: number }>;
    };
  }
}

const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

export function KioskPanel({ onEventCreated }: { onEventCreated?: () => void | Promise<void> }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MediaStream | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [demoLabel, setDemoLabel] = useState<PersonId>("changsuk");
  const [recognized, setRecognized] = useState<RegisteredPersonId | null>(null);
  const [visionConfidence, setVisionConfidence] = useState(0);
  const [voiceConfidence, setVoiceConfidence] = useState(0);
  const [hasFrame, setHasFrame] = useState(false);
  const [message, setMessage] = useState("카메라를 시작해 주세요");

  function stopStream(stream: MediaStream | null) {
    stream?.getTracks().forEach((track) => track.stop());
  }

  useEffect(() => () => {
    stopStream(cameraRef.current);
    stopStream(microphoneRef.current);
  }, []);

  async function persistResult(personId: PersonId, visionVerified: boolean, voiceVerified: boolean, visionScore: number, voiceScore: number | null) {
    const response = await fetch("/api/v1/demo-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        person_id: personId,
        vision_verified: visionVerified,
        voice_verified: voiceVerified,
        vision_confidence: visionScore,
        voice_confidence: voiceScore,
      }),
    });
    if (!response.ok) throw new Error("출석 이벤트 저장에 실패했습니다.");
    await onEventCreated?.();
  }

  async function startCamera() {
    try {
      resetMedia();
      setRecognized(null);
      setHasFrame(false);
      setPhase("CAMERA");
      setMessage("얼굴을 화면 중앙에 맞춰 주세요");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      cameraRef.current = stream;
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      await wait(1_200);
      captureFrame();
      setPhase("VISION");
      setMessage("Vision 모델이 팀원을 확인하고 있습니다");
      await wait(1_100);

      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      const frame = canvas && context
        ? context.getImageData(0, 0, canvas.width, canvas.height)
        : null;
      const result = window.twinpassInference && frame
        ? await window.twinpassInference.identify(frame)
        : { person_id: demoLabel, confidence: demoLabel === "OTHER" ? 0.34 : 0.96 };
      await applyVisionResult(result);
    } catch (error) {
      void error;
      setPhase("ERROR");
      setMessage("카메라 권한 또는 장치 연결을 확인해 주세요");
    } finally {
      stopStream(cameraRef.current);
      cameraRef.current = null;
    }
  }

  function captureFrame() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 360;
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    setHasFrame(true);
  }

  async function startRecording() {
    if (!recognized) return;
    try {
      setPhase("RECORDING");
      setMessage("녹음 중 · hello라고 말해 주세요");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      microphoneRef.current = stream;
      chunksRef.current = [];
      if (typeof MediaRecorder !== "undefined") {
        const recorder = new MediaRecorder(stream);
        recorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data.size) chunksRef.current.push(event.data);
        };
        recorder.start();
      }
      await wait(2_400);
      recorderRef.current?.stop();
      await wait(150);
      setPhase("VOICE");
      setMessage("hello 음성 특징을 검증하고 있습니다");
      const audio = new Blob(chunksRef.current, { type: recorderRef.current?.mimeType || "audio/webm" });
      const result = window.twinpassInference
        ? await window.twinpassInference.verifyHello(audio, recognized)
        : { verified: true, confidence: 0.93 };
      await applyVoiceResult(result);
    } catch (error) {
      void error;
      setPhase("ERROR");
      setMessage("마이크 권한 또는 장치 연결을 확인해 주세요");
    } finally {
      stopStream(microphoneRef.current);
      microphoneRef.current = null;
    }
  }

  function resetMedia() {
    stopStream(cameraRef.current);
    stopStream(microphoneRef.current);
    recorderRef.current = null;
    chunksRef.current = [];
  }

  async function applyVisionResult(result: { person_id: PersonId; confidence: number }) {
    setVisionConfidence(result.confidence);
    if (result.person_id === "OTHER") {
      await persistResult("OTHER", false, false, result.confidence, null);
      setPhase("REJECTED");
      setMessage("등록된 팀원이 아닙니다");
      return;
    }
    setRecognized(result.person_id);
    setPhase("AUDIO_READY");
    setMessage(`${result.person_id} 확인 · 이제 hello라고 말해 주세요`);
  }

  async function applyVoiceResult(result: { verified: boolean; confidence: number }) {
    if (!recognized) return;
    setVoiceConfidence(result.confidence);
    await persistResult(recognized, true, result.verified, visionConfidence, result.confidence);
    setPhase(result.verified ? "SUCCESS" : "REJECTED");
    setMessage(result.verified ? "출석 인증이 완료되었습니다" : "목소리가 일치하지 않습니다");
  }

  async function runDeviceFreeVisionDemo() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) {
      canvas.width = 640;
      canvas.height = 360;
      const gradient = context.createLinearGradient(0, 0, 640, 360);
      gradient.addColorStop(0, "#263554");
      gradient.addColorStop(1, "#121a2d");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 640, 360);
      context.fillStyle = "#8fa0ff";
      context.font = "700 72px system-ui";
      context.textAlign = "center";
      context.fillText(demoLabel === "OTHER" ? "?" : demoLabel[0].toUpperCase(), 320, 205);
    }
    setHasFrame(true);
    setPhase("VISION");
    setMessage("장치 없는 데모 Vision 판정 중");
    await wait(900);
    await applyVisionResult({ person_id: demoLabel, confidence: demoLabel === "OTHER" ? 0.34 : 0.96 });
  }

  async function runDeviceFreeVoiceDemo() {
    setPhase("RECORDING");
    setMessage("장치 없는 데모 · hello 신호 재생 중");
    await wait(1_300);
    setPhase("VOICE");
    setMessage("hello 음성 특징을 검증하고 있습니다");
    await wait(600);
    await applyVoiceResult({ verified: true, confidence: 0.93 });
  }

  function reset() {
    resetMedia();
    setPhase("IDLE");
    setRecognized(null);
    setVisionConfidence(0);
    setVoiceConfidence(0);
    setHasFrame(false);
    setMessage("카메라를 시작해 주세요");
  }

  const profile = recognized ? teamProfiles[recognized] : null;
  const busy = ["CAMERA", "VISION", "RECORDING", "VOICE"].includes(phase);

  return (
    <main className="public-kiosk">
      <header className="public-kiosk-header">
        <div className="brand public-brand"><span className="brand-mark">T</span><span>TwinPass</span></div>
        <span className="local-badge"><i />Local inference</span>
      </header>

      <div className="simple-kiosk-grid">
        <section className="simple-camera-card" aria-label="출석 인증 카메라">
          <div className="simple-card-title"><div><small>CAMERA</small><strong>얼굴 인증</strong></div><span>01</span></div>
          <div className={`camera-stage simple-camera phase-${phase.toLowerCase()}`}>
        <video ref={videoRef} muted playsInline className={hasFrame ? "hidden-media" : ""} />
        <canvas ref={canvasRef} className={hasFrame ? "" : "hidden-media"} />
        {!hasFrame && phase === "IDLE" && <div className="camera-empty"><span>◎</span><p>Camera ready</p></div>}
        <div className="face-guide"><i /><i /><i /><i /></div>
        <span className="camera-live"><b />{phase === "CAMERA" ? "CAPTURING" : phase === "VISION" ? "ANALYZING" : "LOCAL"}</span>
        {busy && <div className="scan-line" />}
        {phase === "SUCCESS" && profile && (
          <div className="profile-overlay">
            <span style={{ background: profile.accent }}>{profile.name[0].toUpperCase()}</span>
            <div><small>ATTENDANCE COMPLETE</small><strong>{profile.name}</strong><p>{profile.team}</p></div>
            <b>✓</b>
          </div>
        )}
        {phase === "REJECTED" && <div className="reject-overlay"><b>×</b><strong>인증 실패</strong></div>}
          </div>
          <p className="privacy-note">사진과 영상은 서버에 저장되지 않습니다.</p>
        </section>

        <section className="simple-checkin-card">
          <div className="simple-card-title"><div><small>CHECK-IN</small><strong>출석 확인</strong></div><span>02</span></div>
          <div className="simple-status">
            <span className={`phase-indicator ${phase.toLowerCase()}`} />
            <div><h1>{message}</h1><p>{phase === "RECORDING" ? "마이크에 대고 hello라고 말해 주세요." : "얼굴과 목소리를 순서대로 확인합니다."}</p></div>
          </div>

          {profile && <div className="simple-profile"><span style={{ background: profile.accent }}>{profile.name[0].toUpperCase()}</span><div><small>{phase === "SUCCESS" ? "ATTENDANCE COMPLETE" : "TEAM MEMBER"}</small><strong>{profile.name}</strong><p>{profile.team}</p></div>{phase === "SUCCESS" && <b>✓</b>}</div>}

          <div className="simple-steps">
            <Step number="1" label="Face" active={["CAMERA", "VISION"].includes(phase)} done={Boolean(recognized)} />
            <i />
            <Step number="2" label="Voice" active={["AUDIO_READY", "RECORDING", "VOICE"].includes(phase)} done={phase === "SUCCESS"} />
            <i />
            <Step number="3" label="Done" active={phase === "SUCCESS"} done={phase === "SUCCESS"} />
          </div>

          <details className="demo-settings">
            <summary>데모 설정</summary>
            <label>Vision 판정
              <select value={demoLabel} onChange={(event) => setDemoLabel(event.target.value as PersonId)} disabled={busy}>
                {personIds.map((person) => <option key={person} value={person}>{person}</option>)}
              </select>
            </label>
          </details>

          <div className="kiosk-actions simple-actions">
            {phase === "IDLE" && <button className="primary-action" onClick={startCamera}>Start</button>}
            {phase === "ERROR" && !recognized && <button className="secondary-action" onClick={runDeviceFreeVisionDemo}>카메라 없이 데모</button>}
            {phase === "ERROR" && recognized && <button className="secondary-action" onClick={runDeviceFreeVoiceDemo}>마이크 없이 hello 테스트</button>}
            {(["REJECTED", "SUCCESS"].includes(phase)) && <button className="primary-action" onClick={reset}>처음으로</button>}
            {phase === "AUDIO_READY" && <button className="record-action" onClick={startRecording}><span />녹음 시작</button>}
            {busy && <button className="primary-action" disabled>{phase === "RECORDING" ? "hello 감지 중…" : "확인 중…"}</button>}
          </div>

          {phase === "SUCCESS" && <div className="confidence-row simple-confidence"><span>Vision <b>{Math.round(visionConfidence * 100)}%</b></span><span>Voice <b>{Math.round(voiceConfidence * 100)}%</b></span></div>}
        </section>
      </div>
      <footer className="public-footer"><span>Vision → Voice → Attendance</span><span>Edge AI · No biometric upload</span></footer>
    </main>
  );
}

function Step({ number, label, active, done }: { number: string; label: string; active: boolean; done: boolean }) {
  return <div className={`verify-step ${active ? "active" : ""} ${done ? "done" : ""}`}><b>{done ? "✓" : number}</b><span>{label}</span></div>;
}
