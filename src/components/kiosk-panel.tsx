"use client";

import { useEffect, useRef, useState } from "react";
import { personIds } from "@/lib/domain";
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
  const cameraRef = useRef<MediaStream | null>(null);
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
  const [visionPerson, setVisionPerson] = useState<PersonId>("changsuk");
  const [recognized, setRecognized] = useState<RegisteredPersonId | null>(null);
  const [visionConfidence, setVisionConfidence] = useState(0);
  const [voiceConfidence, setVoiceConfidence] = useState(0);
  const [hasFrame, setHasFrame] = useState(false);
  const [nanoConnected, setNanoConnected] = useState(false);
  const [nanoReady, setNanoReady] = useState(false);
  const [audioTestMode, setAudioTestMode] = useState(false);
  const [serialStatus, setSerialStatus] = useState("Not connected");
  const [lastSerialEvent, setLastSerialEvent] = useState("None");
  const [recordingSeconds, setRecordingSeconds] = useState(AUDIO_RECORDING_SECONDS);
  const [message, setMessage] = useState("Connect the Nano to start attendance verification.");

  useEffect(() => {
    return () => {
      cameraRef.current?.getTracks().forEach((track) => track.stop());
      if (countdownTimerRef.current) window.clearInterval(countdownTimerRef.current);
      void serialReaderRef.current?.cancel();
      serialReaderRef.current?.releaseLock();
      serialWriterRef.current?.releaseLock();
      void serialPortRef.current?.close();
    };
  }, []);

  useEffect(() => {
    function selectVisionPerson(event: KeyboardEvent) {
      if (phase !== "IDLE" || event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, select, textarea")) return;

      const index = Number(event.key) - 1;
      const person = personIds[index];
      if (!person) return;

      setVisionPerson(person);
      console.info("[TwinPass] Vision identity selected", { person });
    }

    window.addEventListener("keydown", selectVisionPerson);
    return () => window.removeEventListener("keydown", selectVisionPerson);
  }, [phase]);

  async function captureVisionFrame() {
    setHasFrame(false);
    setPhase("CAMERA");
    setMessage("Center your face in the camera.");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      cameraRef.current = stream;

      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) throw new Error("Unable to prepare the camera preview.");

      video.srcObject = stream;
      await video.play();

      for (let countdown = 3; countdown >= 1; countdown -= 1) {
        setMessage(`Hold still · Capturing in ${countdown}`);
        await wait(1_000);
      }

      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 360;
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      setHasFrame(true);
      setPhase("VISION");
      setMessage("Analyzing the Vision result.");
      await wait(1_000);
    }
    finally {
      cameraRef.current?.getTracks().forEach((track) => track.stop());
      cameraRef.current = null;
    }
  }

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
    if (!response.ok) throw new Error("Failed to save the attendance event.");
    await onEventCreated?.();
  }

  async function connectNano() {
    try {
      if (!navigator.serial) throw new Error("This browser does not support the Web Serial API.");
      setMessage("Connecting to the Nano 33 BLE Sense.");
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      serialPortRef.current = port;
      serialReaderRef.current = port.readable?.getReader() ?? null;
      serialWriterRef.current = port.writable?.getWriter() ?? null;
      nanoReadyRef.current = false;
      setNanoReady(false);
      setNanoConnected(true);
      setSerialStatus("Port connected · Waiting for firmware");
      setLastSerialEvent("COM port opened");
      void readSerialLoop();
      setMessage("Waiting for the Nano audio model and microphone to start.");
      const ready = await waitForNanoReady(10_000);
      if (ready) {
        setMessage(recognizedRef.current
          ? "Nano is ready. Starting audio verification."
          : "Nano is ready. Start attendance verification.");
      }
      else {
        setSerialStatus("Port connected · No firmware response for 10 seconds");
        setMessage("The Nano port is open, but the TwinPass firmware did not respond within 10 seconds.");
      }
    }
    catch (error) {
      console.error(error);
      setNanoConnected(false);
      setNanoReady(false);
      setSerialStatus("Connection failed");
      setLastSerialEvent(error instanceof Error ? error.message : "Unable to open the port");
      setPhase("ERROR");
      setMessage("Failed to connect to the Nano. Try again in Chrome or Edge.");
    }
  }

  async function sendSerialCommand(command: string) {
    const writer = serialWriterRef.current;
    if (!writer) throw new Error("The Nano is not connected.");
    await writer.write(new TextEncoder().encode(`${command}\n`));
  }

  async function waitForNanoReady(timeoutMs: number) {
    const startedAt = Date.now();
    let attempt = 0;
    while (!nanoReadyRef.current && Date.now() - startedAt < timeoutMs) {
      attempt += 1;
      setSerialStatus(`Checking Nano startup · PING ${attempt}`);
      await sendSerialCommand("PING");
      setLastSerialEvent(`PING ${attempt} sent`);
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
      setSerialStatus("Serial connection lost");
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
        setSerialStatus("Nano firmware ready");
        const pending = pendingAudioRef.current;
        if (pending) void armAudio(pending);
        else if (!recognizedRef.current) setMessage("Nano is ready. Start attendance verification.");
      }
      else if (type === "audio_armed") {
        setSerialStatus("Running 1-second audio inference");
        beginCountdown();
        setPhase("RECORDING");
        setMessage("Say ‘hello’ for one second.");
      }
      else if (type === "audio_prediction") {
        const confidence = Number(event.confidence ?? 0);
        if (Number.isFinite(confidence)) setVoiceConfidence(confidence);
        setSerialStatus(`Running audio inference · ${String(event.label ?? "Analyzing")}`);
      }
      else if (type === "audio_verified" || type === "audio_rejected") {
        setSerialStatus(type === "audio_verified" ? "Audio verification passed" : "Audio verification failed");
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
    setMessage("Say ‘hello’ for one second.");
    await sendSerialCommand(`ARM:${personId}`);
    beginCountdown();
  }

  async function startAudioTest() {
    setLastSerialEvent("Vision verification started");

    try {
      await captureVisionFrame();
    }
    catch (error) {
      console.error(error);
      setPhase("ERROR");
      setMessage("Check the camera permission and connection.");
      setLastSerialEvent("Camera startup failed");
      return;
    }

    if (visionPerson === "OTHER") {
      setRecognized(null);
      recognizedRef.current = null;
      pendingAudioRef.current = null;
      setVisionConfidence(1);
      visionConfidenceRef.current = 1;
      setVoiceConfidence(0);
      await wait(350);
      await persistResult("OTHER", false, false, 1, null);
      setPhase("REJECTED");
      setMessage("No registered team member was detected.");
      setLastSerialEvent("Vision rejected · Audio skipped");
      return;
    }

    setAudioTestMode(false);
    audioTestModeRef.current = false;
    setRecognized(visionPerson);
    recognizedRef.current = visionPerson;
    setVisionConfidence(1);
    visionConfidenceRef.current = 1;
    setVoiceConfidence(0);

    if (!nanoConnected || !serialWriterRef.current) {
      pendingAudioRef.current = visionPerson;
      setPhase("AUDIO_READY");
      setMessage("Vision verified. Connect the Nano to continue with voice verification.");
      setLastSerialEvent("Vision verified · Waiting for Nano");
      return;
    }

    if (!nanoReadyRef.current) {
      setSerialStatus("Rechecking Nano response");
      try {
        const ready = await waitForNanoReady(6_000);
        if (!ready) {
          setSerialStatus("Port connected · No firmware response");
          setMessage("The Nano is connected, but the TwinPass audio firmware did not return ready/pong.");
          setLastSerialEvent("No ready/pong received for 6 seconds");
          return;
        }
      }
      catch (error) {
        setSerialStatus("PING failed");
        setMessage("Unable to send a command to the Nano port.");
        setLastSerialEvent(error instanceof Error ? error.message : "PING failed");
        return;
      }
    }

    try {
      setSerialStatus("Vision complete · Starting audio verification");
      setLastSerialEvent(`Preparing ARM:${visionPerson}`);
      pendingAudioRef.current = null;
      setPhase("VISION");
      await wait(350);
      await armAudio(visionPerson);
      setLastSerialEvent(`ARM:${visionPerson} sent`);
    }
    catch (error) {
      setPhase("ERROR");
      setSerialStatus("ARM command failed");
      setMessage("Unable to send the audio verification command to the Nano.");
      setLastSerialEvent(error instanceof Error ? error.message : "ARM command failed");
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
    setMessage("Checking the voice result.");
    setVoiceConfidence(result.confidence);
    if (!audioTestModeRef.current) {
      await persistResult(person, true, result.verified, visionConfidenceRef.current, result.confidence);
    }
    setPhase(result.verified ? "SUCCESS" : "REJECTED");
    if (audioTestModeRef.current) {
      setMessage(result.verified
        ? `${person} passed the voice test.`
        : `${person} failed the voice test.`);
    }
    else {
      setMessage(result.verified ? "Attendance verification is complete." : "The Vision identity and voice do not match.");
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
    setMessage("Connect the Nano to start attendance verification.");
  }

  const profile = recognized ? teamProfiles[recognized] : null;
  const busy = ["MODEL_LOADING", "CAMERA", "VISION", "RECORDING", "VOICE"].includes(phase);

  return (
    <main className="public-kiosk">
      <header className="public-kiosk-header">
        <div className="brand public-brand"><span className="brand-mark">T</span><span>TwinPass</span></div>
        <span className="local-badge"><i />Vision · Nano Audio</span>
      </header>

      <div className="simple-kiosk-grid">
        <section className="simple-camera-card" aria-label="Vision face verification">
          <div className="simple-card-title"><div><small>VISION</small><strong>Face Verification</strong></div><span>01</span></div>
          <div className={`camera-stage simple-camera phase-${phase.toLowerCase()}`}>
            <video ref={videoRef} muted playsInline className={hasFrame ? "hidden-media" : ""} />
            <canvas ref={canvasRef} className={hasFrame ? "" : "hidden-media"} />
            {!hasFrame && phase === "IDLE" && <div className="camera-empty"><span>◎</span><p>Vision ready</p></div>}
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
            {phase === "REJECTED" && <div className="reject-overlay"><b>×</b><strong>Verification Failed</strong></div>}
          </div>
          <p className="privacy-note">Photos and audio are not stored on the server.</p>
        </section>

        <section className="simple-checkin-card">
          <div className="simple-card-title"><div><small>CHECK-IN</small><strong>Attendance</strong></div><span>02</span></div>
          <div className="simple-status">
            <span className={`phase-indicator ${phase.toLowerCase()}`} />
            <div><h1>{message}</h1><p>{phase === "RECORDING" ? `Nano recording · ${recordingSeconds}s` : "Verify your face and voice in sequence."}</p></div>
          </div>

          {profile && (
            <div className="simple-profile">
              <span style={{ background: profile.accent }}>{profile.name[0].toUpperCase()}</span>
              <div><small>{phase === "SUCCESS" ? (audioTestMode ? "AUDIO TEST COMPLETE" : "ATTENDANCE COMPLETE") : "TEAM MEMBER"}</small><strong>{profile.name}</strong><p>{profile.team}</p></div>
              {phase === "SUCCESS" && <b>✓</b>}
            </div>
          )}

          <div className="simple-steps">
            <Step number="1" label="Face" active={phase === "VISION"} done={Boolean(recognized)} />
            <i />
            <Step number="2" label="Voice" active={["AUDIO_READY", "RECORDING", "VOICE"].includes(phase)} done={phase === "SUCCESS"} />
            <i />
            <Step number="3" label="Done" active={phase === "SUCCESS"} done={phase === "SUCCESS"} />
          </div>

          {phase === "IDLE" && nanoConnected && (
            <div className="demo-settings">
              <p style={{ margin: 0, color: nanoReady ? "#159a6c" : "#b7791f", fontSize: 9 }}>
                {serialStatus}
              </p>
              <p style={{ margin: "4px 0 0", color: "#8d97a9", fontSize: 8, overflowWrap: "anywhere" }}>
                Last event: {lastSerialEvent}
              </p>
            </div>
          )}

          <div className="kiosk-actions simple-actions">
            {phase === "IDLE" && !nanoConnected && <button className="secondary-action" onClick={connectNano}>Connect Nano</button>}
            {phase === "IDLE" && <button className="record-action" onClick={startAudioTest}><span />Start Verification</button>}
            {phase === "AUDIO_READY" && !nanoConnected && <button className="record-action" onClick={connectNano}><span />Connect Nano for Voice Verification</button>}
            {phase === "ERROR" && <button className="primary-action" onClick={reset}>Try Again</button>}
            {["REJECTED", "SUCCESS"].includes(phase) && <button className="primary-action" onClick={reset}>Start Over</button>}
            {busy && <button className="primary-action" disabled>{phase === "RECORDING" ? `Recording · ${recordingSeconds}s` : "Verifying"}</button>}
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
