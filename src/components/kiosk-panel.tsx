"use client";

import { useEffect, useRef, useState } from "react";
import { personIds, registeredPersonIds } from "@/lib/domain";
import { teamProfiles, type RegisteredPersonId } from "@/lib/people";

type Phase = "IDLE" | "MODEL_LOADING" | "CAMERA" | "VISION" | "AUDIO_READY" | "RECORDING" | "VOICE" | "SUCCESS" | "REJECTED" | "ERROR";
type PersonId = (typeof personIds)[number];

type SerialReader = ReadableStreamDefaultReader<Uint8Array>;
type SerialWriter = WritableStreamDefaultWriter<Uint8Array>;
type TwinPassSerialPort = {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
};

declare global {
  interface Navigator {
    serial?: { requestPort(): Promise<TwinPassSerialPort> };
  }
}

const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const AUDIO_RECORDING_SECONDS = 1;

export function KioskPanel({ onEventCreated }: { onEventCreated?: () => void | Promise<void> }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const serialPortRef = useRef<TwinPassSerialPort | null>(null);
  const serialReaderRef = useRef<SerialReader | null>(null);
  const serialWriterRef = useRef<SerialWriter | null>(null);
  const serialBufferRef = useRef("");
  const recognizedRef = useRef<RegisteredPersonId | null>(null);
  const pendingAudioRef = useRef<RegisteredPersonId | null>(null);
  const audioTestModeRef = useRef(false);
  const nanoReadyRef = useRef(false);
  const visionConfidenceRef = useRef(0);
  const countdownTimerRef = useRef<number | null>(null);

  const [phase, setPhase] = useState<Phase>("IDLE");
  const [recognized, setRecognized] = useState<RegisteredPersonId | null>(null);
  const [visionConfidence, setVisionConfidence] = useState(0);
  const [voiceConfidence, setVoiceConfidence] = useState(0);
  const [hasFrame, setHasFrame] = useState(false);
  const [nanoConnected, setNanoConnected] = useState(false);
  const [nanoReady, setNanoReady] = useState(false);
  const [audioTestMode, setAudioTestMode] = useState(false);
  const [audioTestPerson, setAudioTestPerson] = useState<RegisteredPersonId>("changsuk");
  const [serialStatus, setSerialStatus] = useState("연결 안 됨");
  const [lastSerialEvent, setLastSerialEvent] = useState("없음");
  const [recordingSeconds, setRecordingSeconds] = useState(AUDIO_RECORDING_SECONDS);
  const [message, setMessage] = useState("Demo Vision 사용자를 선택하고 Nano를 연결해주세요.");

  useEffect(() => {
    return () => {
      if (countdownTimerRef.current) window.clearInterval(countdownTimerRef.current);
      void serialReaderRef.current?.cancel();
      serialReaderRef.current?.releaseLock();
      serialWriterRef.current?.releaseLock();
      void serialPortRef.current?.close();
    };
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

  async function connectNano() {
    try {
      if (!navigator.serial) throw new Error("Web Serial API를 지원하지 않는 브라우저입니다.");
      setMessage("Nano 33 BLE Sense를 연결하고 있습니다.");
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      serialPortRef.current = port;
      serialReaderRef.current = port.readable?.getReader() ?? null;
      serialWriterRef.current = port.writable?.getWriter() ?? null;
      nanoReadyRef.current = false;
      setNanoReady(false);
      setNanoConnected(true);
      setSerialStatus("포트 연결됨 · 펌웨어 응답 대기");
      setLastSerialEvent("COM 포트 열림");
      void readSerialLoop();
      setMessage("Nano 오디오 모델과 마이크가 시작될 때까지 기다리고 있습니다.");
      const ready = await waitForNanoReady(10_000);
      if (ready) {
        setMessage(recognizedRef.current
          ? "Nano가 준비되었습니다. Audio 인증을 시작합니다."
          : "Nano가 준비되었습니다. Demo Vision 사용자를 선택하고 Audio 인증을 시작해주세요.");
      }
      else {
        setSerialStatus("포트 연결됨 · 10초 동안 펌웨어 응답 없음");
        setMessage("Nano 포트는 열렸지만 TwinPass 펌웨어가 10초 동안 응답하지 않았습니다.");
      }
    }
    catch (error) {
      console.error(error);
      setNanoConnected(false);
      setNanoReady(false);
      setSerialStatus("연결 실패");
      setLastSerialEvent(error instanceof Error ? error.message : "포트를 열 수 없음");
      setPhase("ERROR");
      setMessage("Nano 연결에 실패했습니다. Chrome 또는 Edge에서 다시 시도해주세요.");
    }
  }

  async function sendSerialCommand(command: string) {
    const writer = serialWriterRef.current;
    if (!writer) throw new Error("Nano가 연결되지 않았습니다.");
    await writer.write(new TextEncoder().encode(`${command}\n`));
  }

  async function waitForNanoReady(timeoutMs: number) {
    const startedAt = Date.now();
    let attempt = 0;
    while (!nanoReadyRef.current && Date.now() - startedAt < timeoutMs) {
      attempt += 1;
      setSerialStatus(`Nano 부팅 확인 중 · PING ${attempt}`);
      await sendSerialCommand("PING");
      setLastSerialEvent(`PING ${attempt} 전송`);
      await wait(1_000);
    }
    return nanoReadyRef.current;
  }

  async function readSerialLoop() {
    const reader = serialReaderRef.current;
    if (!reader) return;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        serialBufferRef.current += decoder.decode(value, { stream: true });
        const lines = serialBufferRef.current.split(/\r?\n/);
        serialBufferRef.current = lines.pop() ?? "";
        for (const line of lines) handleSerialLine(line.trim());
      }
    }
    catch (error) {
      console.error(error);
      setNanoConnected(false);
      nanoReadyRef.current = false;
      setNanoReady(false);
      setSerialStatus("Serial 연결 끊김");
    }
  }

  function handleSerialLine(line: string) {
    if (!line) return;
    setLastSerialEvent(line.length > 100 ? `${line.slice(0, 100)}…` : line);
    if (!line.startsWith("{")) return;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = String(event.type ?? "");
      if (type === "ready" || type === "pong") {
        nanoReadyRef.current = true;
        setNanoReady(true);
        setSerialStatus("Nano 펌웨어 준비 완료");
        const pending = pendingAudioRef.current;
        if (pending) void armAudio(pending);
        else if (!recognizedRef.current) setMessage("Nano가 준비되었습니다. Demo Vision 사용자를 선택하고 Audio 인증을 시작해주세요.");
      }
      else if (type === "audio_armed") {
        setSerialStatus("1초 Audio 추론 중");
        beginCountdown();
        setPhase("RECORDING");
        setMessage("1초 동안 ‘hello’라고 말해주세요.");
      }
      else if (type === "audio_prediction") {
        const confidence = Number(event.confidence ?? 0);
        if (Number.isFinite(confidence)) setVoiceConfidence(confidence);
        setSerialStatus(`Audio 추론 중 · ${String(event.label ?? "분석 중")}`);
      }
      else if (type === "audio_verified" || type === "audio_rejected") {
        setSerialStatus(type === "audio_verified" ? "Audio 인증 성공" : "Audio 인증 실패");
        stopCountdown();
        const confidence = Number(event.confidence ?? 0);
        void applyVoiceResult({ verified: type === "audio_verified", confidence });
      }
    }
    catch {
      // Edge Impulse diagnostic lines are not JSON and can be ignored.
    }
  }

  async function armAudio(personId: RegisteredPersonId) {
    pendingAudioRef.current = null;
    setPhase("RECORDING");
    setRecordingSeconds(AUDIO_RECORDING_SECONDS);
    setMessage("1초 동안 ‘hello’라고 말해주세요.");
    await sendSerialCommand(`ARM:${personId}`);
    beginCountdown();
  }

  async function startAudioTest() {
    setMessage(`${audioTestPerson}을 Demo Vision 사용자로 설정했습니다.`);
    setLastSerialEvent(`Demo Vision: ${audioTestPerson}`);
    if (!nanoReadyRef.current) {
      setSerialStatus("Nano 응답 재확인 중");
      try {
        const ready = await waitForNanoReady(6_000);
        if (!ready) {
          setSerialStatus("포트 연결됨 · 펌웨어 응답 없음");
          setMessage("Nano는 연결됐지만 TwinPass 오디오 펌웨어의 ready/pong 응답이 없습니다.");
          setLastSerialEvent("6초 동안 ready/pong 수신 안 됨");
          return;
        }
      }
      catch (error) {
        setSerialStatus("PING 전송 실패");
        setMessage("Nano 포트에 명령을 전송하지 못했습니다.");
        setLastSerialEvent(error instanceof Error ? error.message : "PING 전송 실패");
        return;
      }
    }

    try {
      setSerialStatus("Demo Vision 완료 · Audio 인증 시작");
      setLastSerialEvent(`ARM:${audioTestPerson} 전송 준비`);
      setAudioTestMode(false);
      audioTestModeRef.current = false;
      setRecognized(audioTestPerson);
      recognizedRef.current = audioTestPerson;
      pendingAudioRef.current = null;
      setVisionConfidence(1);
      visionConfidenceRef.current = 1;
      setVoiceConfidence(0);
      setPhase("VISION");
      await wait(350);
      await armAudio(audioTestPerson);
      setLastSerialEvent(`ARM:${audioTestPerson} 전송 완료`);
    }
    catch (error) {
      setPhase("ERROR");
      setSerialStatus("ARM 명령 전송 실패");
      setMessage("Audio 인증 시작 명령을 Nano에 보내지 못했습니다.");
      setLastSerialEvent(error instanceof Error ? error.message : "ARM 전송 실패");
      return;
    }
  }

  function beginCountdown() {
    stopCountdown();
    setRecordingSeconds(AUDIO_RECORDING_SECONDS);
    const startedAt = Date.now();
    countdownTimerRef.current = window.setInterval(() => {
      setRecordingSeconds(Math.max(0, AUDIO_RECORDING_SECONDS - Math.floor((Date.now() - startedAt) / 1000)));
    }, 200);
  }

  function stopCountdown() {
    if (countdownTimerRef.current) window.clearInterval(countdownTimerRef.current);
    countdownTimerRef.current = null;
  }

  async function applyVoiceResult(result: { verified: boolean; confidence: number }) {
    const person = recognizedRef.current;
    if (!person) return;
    setPhase("VOICE");
    setMessage("목소리 결과를 확인하고 있습니다.");
    setVoiceConfidence(result.confidence);
    if (!audioTestModeRef.current) {
      await persistResult(person, true, result.verified, visionConfidenceRef.current, result.confidence);
    }
    setPhase(result.verified ? "SUCCESS" : "REJECTED");
    if (audioTestModeRef.current) {
      setMessage(result.verified
        ? `${person} 음성 테스트에 성공했습니다.`
        : `${person} 음성 테스트에 실패했습니다.`);
    }
    else {
      setMessage(result.verified ? "출석 인증이 완료되었습니다." : "Vision 사용자와 목소리가 일치하지 않습니다.");
    }
  }

  function reset() {
    stopCountdown();
    recognizedRef.current = null;
    pendingAudioRef.current = null;
    audioTestModeRef.current = false;
    setPhase("IDLE");
    setRecognized(null);
    setVisionConfidence(0);
    setVoiceConfidence(0);
    setHasFrame(false);
    setRecordingSeconds(AUDIO_RECORDING_SECONDS);
    setAudioTestMode(false);
    setMessage("Demo Vision 사용자를 선택하고 Nano를 연결해주세요.");
  }

  const profile = recognized ? teamProfiles[recognized] : null;
  const busy = ["MODEL_LOADING", "CAMERA", "VISION", "RECORDING", "VOICE"].includes(phase);

  return (
    <main className="public-kiosk">
      <header className="public-kiosk-header">
        <div className="brand public-brand"><span className="brand-mark">T</span><span>TwinPass</span></div>
        <span className="local-badge"><i />Demo Vision · Nano Audio</span>
      </header>

      <div className="simple-kiosk-grid">
        <section className="simple-camera-card" aria-label="Demo Vision 사용자 설정">
          <div className="simple-card-title"><div><small>DEMO VISION</small><strong>사용자 설정</strong></div><span>01</span></div>
          <div className={`camera-stage simple-camera phase-${phase.toLowerCase()}`}>
            <video ref={videoRef} muted playsInline className={hasFrame ? "hidden-media" : ""} />
            <canvas ref={canvasRef} className={hasFrame ? "" : "hidden-media"} />
            {!hasFrame && phase === "IDLE" && <div className="camera-empty"><span>{audioTestPerson[0].toUpperCase()}</span><p>Demo user · {audioTestPerson}</p></div>}
            <div className="face-guide"><i /><i /><i /><i /></div>
            <span className="camera-live"><b />{phase === "CAMERA" ? "CAPTURING" : phase === "VISION" ? "ANALYZING" : "LOCAL"}</span>
            {busy && <div className="scan-line" />}
            {phase === "SUCCESS" && profile && (
              <div className="profile-overlay">
                <span style={{ background: profile.accent }}>{profile.name[0].toUpperCase()}</span>
                <div><small>{audioTestMode ? "AUDIO TEST PASSED" : "ATTENDANCE COMPLETE"}</small><strong>{profile.name}</strong><p>{profile.team}</p></div>
                <b>✓</b>
              </div>
            )}
            {phase === "REJECTED" && <div className="reject-overlay"><b>×</b><strong>인증 실패</strong></div>}
          </div>
          <p className="privacy-note">카메라는 사용하지 않으며 선택된 사용자로 Vision을 가정합니다.</p>
        </section>

        <section className="simple-checkin-card">
          <div className="simple-card-title"><div><small>CHECK-IN</small><strong>출석 확인</strong></div><span>02</span></div>
          <div className="simple-status">
            <span className={`phase-indicator ${phase.toLowerCase()}`} />
            <div><h1>{message}</h1><p>{phase === "RECORDING" ? `Nano 녹음 중 · ${recordingSeconds}초` : "얼굴과 목소리를 순서대로 확인합니다."}</p></div>
          </div>

          {profile && (
            <div className="simple-profile">
              <span style={{ background: profile.accent }}>{profile.name[0].toUpperCase()}</span>
              <div><small>{phase === "SUCCESS" ? (audioTestMode ? "AUDIO TEST COMPLETE" : "ATTENDANCE COMPLETE") : "TEAM MEMBER"}</small><strong>{profile.name}</strong><p>{profile.team}</p></div>
              {phase === "SUCCESS" && <b>✓</b>}
            </div>
          )}

          <div className="simple-steps">
            <Step number="1" label="Demo" active={phase === "VISION"} done={Boolean(recognized)} />
            <i />
            <Step number="2" label="Voice" active={["AUDIO_READY", "RECORDING", "VOICE"].includes(phase)} done={phase === "SUCCESS"} />
            <i />
            <Step number="3" label="Done" active={phase === "SUCCESS"} done={phase === "SUCCESS"} />
          </div>

          {phase === "IDLE" && (
            <div className="demo-settings">
              <label>Demo Vision 사용자
                <select
                  value={audioTestPerson}
                  onChange={(event) => setAudioTestPerson(event.target.value as RegisteredPersonId)}
                  disabled={busy}
                >
                  {registeredPersonIds.map((person) => <option key={person} value={person}>{person}</option>)}
                </select>
              </label>
              {nanoConnected && (
                <>
                  <p style={{ margin: "9px 0 0", color: nanoReady ? "#159a6c" : "#b7791f", fontSize: 9 }}>
                    {serialStatus}
                  </p>
                  <p style={{ margin: "4px 0 0", color: "#8d97a9", fontSize: 8, overflowWrap: "anywhere" }}>
                    마지막 이벤트: {lastSerialEvent}
                  </p>
                </>
              )}
            </div>
          )}

          <div className="kiosk-actions simple-actions">
            {phase === "IDLE" && !nanoConnected && <button className="secondary-action" onClick={connectNano}>Nano 연결</button>}
            {phase === "IDLE" && nanoConnected && <button className="record-action" onClick={startAudioTest}><span />{nanoReady ? "Demo Vision → 1초 Audio 인증" : "Nano 응답 확인 후 Audio 인증"}</button>}
            {phase === "AUDIO_READY" && !nanoConnected && <button className="record-action" onClick={connectNano}><span />Nano 연결 후 음성 인증</button>}
            {phase === "ERROR" && <button className="primary-action" onClick={reset}>다시 시도</button>}
            {["REJECTED", "SUCCESS"].includes(phase) && <button className="primary-action" onClick={reset}>처음으로</button>}
            {busy && <button className="primary-action" disabled>{phase === "RECORDING" ? `${recordingSeconds}초 녹음 중` : "확인 중"}</button>}
          </div>

          {(visionConfidence > 0 || voiceConfidence > 0) && (
            <div className="confidence-row simple-confidence">
              <span>Vision <b>{Math.round(visionConfidence * 100)}%</b></span>
              <span>Voice <b>{Math.round(voiceConfidence * 100)}%</b></span>
            </div>
          )}
        </section>
      </div>
      <footer className="public-footer"><span>Vision → Voice → Attendance</span><span>Edge AI · No biometric upload</span></footer>
    </main>
  );
}

function Step({ number, label, active, done }: { number: string; label: string; active: boolean; done: boolean }) {
  return <div className={`verify-step ${active ? "active" : ""} ${done ? "done" : ""}`}><b>{done ? "✓" : number}</b><span>{label}</span></div>;
}
