/* =====================================================================
 * "Annotate" — issue reports for the Valet Waste CRM staff
 * ---------------------------------------------------------------------
 * Ported from the AllSync issue-report-kit (PROMPT.md: integrate, don't
 * redesign). A flag in the topbar (any signed-in admin/staff member, every
 * screen). Click it and the current screen is captured (html-to-image), the
 * staff member marks it up with the bundled PhotoMarkup editor, adds a
 * title + notes, and can record a video of the problem — screen + microphone —
 * with the browser's own recorder (getDisplayMedia + getUserMedia mic track,
 * MediaRecorder); no third-party accounts. The marked-up JPEG and the
 * recording upload to the public `tickets` bucket (unguessable paths), a row
 * lands in issue_reports, and the issue-report edge function emails the
 * owner with everything. Row FIRST (RLS-checked), email poke second — a
 * failed email never loses the report. All reports are visible (with a
 * reply/status history) in the Annotations tab.
 * ===================================================================== */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toJpeg } from "html-to-image";
import { Ic, Svg } from "./icons.jsx";             // bundled shim
import PhotoMarkup from "./PhotoMarkup.jsx";       // bundled, dependency-free
// CRM equivalents of the kit's ADAPT imports:
import { supabase, hasSupabase } from "../lib/supabaseClient.js";

const MAX_VIDEO_MS = 5 * 60 * 1000; // hard cap: 5 minutes
// CRM app root element id (index.html) — the screenshot capture target.
const CAPTURE_ROOT_ID = "root";

/* ---------- the topbar flag + the whole flow ---------- */
export function IssueReportButton({ screen, user, showToast }) {
  const [open, setOpen] = useState(false);
  const [shot, setShot] = useState(null);        // data URL of the (marked-up) screenshot
  const shotBlobRef = useRef(null);              // marked-up PhotoMarkup blob (object URLs aren't data URLs)
  const [marking, setMarking] = useState(false); // PhotoMarkup overlay open
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  /* Element pinning: hover an element on the live page, click to pin it —
   * the captured screenshot gets a highlight box and the report records WHAT
   * the element was (label + CSS path). Enter/Escape/the hint's skip link
   * capture the plain full page instead. */
  const [pinning, setPinning] = useState(false);
  const [hover, setHover] = useState(null);      // {x,y,w,h} viewport rect while hovering
  const [pinned, setPinned] = useState(null);    // { target_label, selector, box } viewport coords
  const pinRef = useRef(null);                   // currently hovered element
  const captureRef = useRef("");
  const [capturing, setCapturing] = useState(false); // toJpeg takes a beat — say so

  /* Recorder state */
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const [videoBlob, setVideoBlob] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null); // object URL for preview
  const recRef = useRef(null);                    // { recorder, stream, chunks, timer }
  const [micOn, setMicOn] = useState(false);      // mic track granted → tell the HUD
  const canRecord = typeof navigator !== "undefined"
    && !!navigator.mediaDevices?.getDisplayMedia && typeof window.MediaRecorder !== "undefined";

  /* Best-effort CSS path for a pinned element (max depth 4, stops at BODY
   * or the first id). */
  const cssPath = (el) => {
    try {
      const parts = [];
      let n = el;
      for (let depth = 0; n && n.tagName !== "BODY" && depth < 4; depth++) {
        let part = n.tagName.toLowerCase();
        if (n.id) { parts.unshift(part + "#" + n.id); break; }
        const cls = String(n.className || "").split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) part += "." + cls.join(".");
        const parent = n.parentElement;
        if (parent) {
          const same = [...parent.children].filter((c) => c.tagName === n.tagName);
          if (same.length > 1) part += `:nth-of-type(${[...parent.children].indexOf(n) + 1})`;
        }
        parts.unshift(part);
        n = parent;
      }
      return parts.join(" > ");
    } catch { return null; }
  };

  /* Burn a highlight box for the pinned element into the captured JPEG so
   * the report shows exactly what was pinned, even before markup. */
  const burnPin = async (dataUrl, box) => {
    if (!box) return dataUrl;
    try {
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = dataUrl;
      });
      const cv = document.createElement("canvas");
      cv.width = img.width; cv.height = img.height;
      const cx = cv.getContext("2d");
      cx.drawImage(img, 0, 0);
      const sc = img.width / window.innerWidth; // capture is viewport-width at pixelRatio 1
      cx.fillStyle = "rgba(31,122,77,.18)";
      cx.strokeStyle = "#1f7a4d";
      cx.lineWidth = 3 * sc;
      cx.fillRect(box.x * sc, box.y * sc, box.w * sc, box.h * sc);
      cx.strokeRect(box.x * sc, box.y * sc, box.w * sc, box.h * sc);
      return cv.toDataURL("image/jpeg", 0.85);
    } catch { return dataUrl; }
  };

  const capture = async (pin) => {
    let url = null;
    setCapturing(true);
    try {
      try {
        const node = document.getElementById(CAPTURE_ROOT_ID) || document.body;
        url = await toJpeg(node, { quality: 0.85, pixelRatio: 1 });
      } catch { /* tainted canvas / font fetch — proceed without a shot */ }
      captureRef.current = location.pathname + location.search;
      if (url && pin) url = await burnPin(url, pin.box);
    } finally {
      setCapturing(false);
    }
    setShot(url);
    shotBlobRef.current = null; // fresh capture — any marked-up blob is stale now
    setTitle(""); setNote(""); setVideoBlob(null); setVideoUrl(null);
    setDone(false); setRecording(false); setRecSecs(0); setMicOn(false);
    setPinning(false); setHover(null);
    setOpen(true);
  };

  const start = () => {
    // Arm element mode: hovering highlights page elements; clicking one pins
    // it. Enter (or the hint's "capture full page") takes a plain capture.
    setPinned(null);
    setPinning(true);
  };

  /* Element-mode listeners: hover highlight + click-to-pin + Enter/Escape. */
  useEffect(() => {
    if (!pinning) return undefined;
    const skip = (e) => !e.target?.closest || !!e.target.closest(".ir-ui, .ops-modal-scrim, .modal-scrim");
    const move = (e) => {
      if (e.target.closest("svg") && e.target.closest("button")) { /* keep the button */ }
      if (skip(e)) { setHover(null); pinRef.current = null; return; }
      pinRef.current = e.target;
      const r = e.target.getBoundingClientRect();
      setHover({ x: r.left, y: r.top, w: r.width, h: r.height });
    };
    const onClick = (e) => {
      if (skip(e)) return;
      e.preventDefault(); e.stopPropagation();
      const el = pinRef.current || e.target;
      const r = el.getBoundingClientRect();
      /* Coordinates relative to the captured node (#root), not the viewport —
       * the JPEG is the full page, so a scrolled viewport would misplace the
       * highlight. */
      const root = document.getElementById(CAPTURE_ROOT_ID) || document.body;
      const rr = root.getBoundingClientRect();
      const pin = {
        target_label: (el.innerText || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 90),
        selector: cssPath(el),
        box: {
          x: Math.round(r.left - rr.left), y: Math.round(r.top - rr.top),
          w: Math.round(r.width), h: Math.round(r.height),
        },
      };
      setPinned(pin);
      setPinning(false); setHover(null);
      capture(pin);
    };
    const onKey = (e) => {
      if (e.key === "Enter") { setPinning(false); setHover(null); capture(null); }
      if (e.key === "Escape") {
        setPinning(false); setHover(null);
        if (shot) setOpen(true);   // cancelled a re-capture — back to the form
      }
    };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [pinning]);

  const stopRecording = () => {
    const r = recRef.current;
    if (!r) return;
    clearInterval(r.timer);
    try { r.recorder.stop(); } catch { /* already stopped */ }
    r.stream.getTracks().forEach((t) => t.stop());  // display AND mic tracks
    recRef.current = null;
    setRecording(false);
    setMicOn(false);
    setOpen(true);   // recording hid the form — bring it back with the video attached
  };

  /* Returns true when recording actually started (the share dialog was
   * confirmed); false on cancel/block so the caller can restore the form.
   * Voice: the DISPLAY stream is requested FIRST because getDisplayMedia
   * requires transient user activation (the click) and the mic permission
   * prompt can burn that window; getUserMedia has no gesture requirement.
   * A denied/dismissed mic downgrades to a video-only recording instead of
   * failing the whole capture. */
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        // audio: true asks Chrome for tab audio when sharing a TAB (the
        // picker checkbox); window/full-screen shares stay silent there.
        // The microphone is added as a separate track below either way.
        video: { frameRate: 12 }, audio: true,
      });
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        mic.getAudioTracks().forEach((t) => stream.addTrack(t));
        setMicOn(true);
      } catch { setMicOn(false); }
      const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"]
        .find((m) => MediaRecorder.isTypeSupported(m)) || "";
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 1_200_000 } : undefined);
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
        setVideoBlob(blob);
        setVideoUrl(URL.createObjectURL(blob));
      };
      stream.getVideoTracks()[0]?.addEventListener("ended", () => stopRecording());
      recorder.start(1000);
      const timer = setInterval(() => {
        setRecSecs((s) => {
          if ((s + 1) * 1000 >= MAX_VIDEO_MS) stopRecording();
          return s + 1;
        });
      }, 1000);
      recRef.current = { recorder, stream, chunks, timer };
      setRecording(true);
      setRecSecs(0);
      return true;
    } catch {
      showToast?.("Screen recording was cancelled or blocked.");
      return false;
    }
  };

  /* The popup must not be in its own recording: hide it while the camera
   * rolls. A small floating HUD (portal below) carries the timer and the
   * stop button; stopping brings the form back with the video attached. */
  const recordFromForm = async () => {
    setOpen(false);
    if (!(await startRecording())) setOpen(true);
  };

  useEffect(() => () => {
    // Never leave a stream/timer running behind a closed modal.
    const r = recRef.current;
    if (r) { clearInterval(r.timer); r.stream.getTracks().forEach((t) => t.stop()); }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const shotUrl = shot
        ? await upload(shotBlobRef.current || blobFromDataUrl(shot), "jpg")
        : null;
      const vidUrl = videoBlob
        ? await upload(videoBlob, videoBlob.type.includes("mp4") ? "mp4" : "webm")
        : null;
      const { error } = await supabase.from("issue_reports").insert({
        created_by: user.id,
        creator_name: user.full_name || user.email || "",
        creator_email: user.email || null,
        screen: screen || null,
        page_path: captureRef.current || null,
        title: title.trim() || "Issue report",
        note: note.trim() || null,
        target_label: pinned?.target_label || null,
        selector: pinned?.selector || null,
        screenshot_url: shotUrl,
        video_url: vidUrl,
      });
      if (error) throw error;
      // The poke — never blocks success; the row is already filed.
      supabase.functions.invoke("issue-report", { body: {
        title: title.trim() || "Issue report", note: note.trim(),
        screen, page_path: captureRef.current, screenshot_url: shotUrl, video_url: vidUrl,
        target_label: pinned?.target_label || null, selector: pinned?.selector || null,
        creator_name: user.full_name || user.email || "",
      } }).catch(() => {});
      setDone(true);
    } catch (e) {
      showToast?.(e?.message || "Couldn't send the report — please try again.");
    }
    setBusy(false);
  };

  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  // Admins + staff only; signed-out and unconfigured clients never render.
  if (!user || !hasSupabase) return null;
  if (user.role !== "admin" && user.role !== "staff") return null;

  return (
    <>
      {/* Labeled, Adobe-style: no mystery icon — say what it does. */}
      <button className="btn-new" aria-label="Annotate a problem or idea"
        title="Annotate — pin the element with the problem, mark up the screen, record a video; it lands in the Annotations tab"
        onClick={start}>
        <Svg d={Ic.flag} /> <span className="btn-new-label">Annotate</span>
      </button>

      {/* Element-pin mode: hover highlights, click pins, Enter captures the
          plain page, Escape cancels. Portals render to <body> so a filtered
          or transformed ancestor can't break position:fixed. */}
      {pinning && createPortal(
        <div className="ir-ui ir-pin-hint">
          <b>Click the element with the problem</b> to pin it, or
          <button className="link-btn" onClick={() => { setPinning(false); capture(null); }}>capture the full page</button>
          <button className="link-btn" onClick={() => { setPinning(false); if (shot) setOpen(true); }}>cancel</button>
        </div>,
        document.body
      )}
      {pinning && hover && hover.w > 2 && createPortal(
        <div className="ir-ui ir-hover" style={{ left: hover.x, top: hover.y, width: hover.w, height: hover.h }} />,
        document.body
      )}
      {capturing && createPortal(
        <div className="ir-ui ir-capturing">Capturing the screen…</div>,
        document.body
      )}
      {/* Recording HUD: the form hides itself while the camera rolls, so this
        * floating pill is all the report adds to the picture. */}
      {recording && createPortal(
        <div className="ir-ui ir-recording-hud">
          <span className="ir-rec-dot" />
          <b>{mmss(recSecs)}</b> recording{micOn ? " (screen + your voice)" : " (screen only — mic was blocked)"} — the form is hidden; switch to whatever you want to show.
          <button className="btn-primary2" style={{ padding: "7px 14px" }} onClick={stopRecording}>Stop &amp; attach</button>
        </div>,
        document.body
      )}

      {open && createPortal(
        <div className="modal-scrim" style={{ zIndex: 1300 }} onClick={() => !busy && !recording && setOpen(false)}>
          <div className="modal ir-modal" onClick={(e) => e.stopPropagation()}>
            {done ? (
              <>
                <div className="modal-head">
                  <div className="mh-ico" style={{ background: "var(--green-soft)", color: "var(--green)" }}><Svg d={Ic.check} /></div>
                  <div>
                    <h3>Annotation sent</h3>
                    <p>It's in the Annotations tab with your screenshot{videoBlob ? " and video" : ""} — thank you!</p>
                  </div>
                </div>
                <div className="modal-foot">
                  <button className="btn-primary2" onClick={() => setOpen(false)}>Done</button>
                </div>
              </>
            ) : (
              <>
                <div className="modal-head">
                  <div className="mh-ico" style={{ background: "var(--primary-50)", color: "var(--primary)" }}><Svg d={Ic.flag} /></div>
                  <div>
                    <h3>Annotate</h3>
                    <p>Mark up what you're seeing — bug, idea, or anything confusing. The whole team (and the dev agent) sees it in the Annotations tab.</p>
                  </div>
                </div>
                <div className="modal-body">
                  {/* Screenshot */}
                  <div className="field">
                    <span className="ir-lbl">Screenshot{shot ? "" : " unavailable — describe it below or record a video"}</span>
                    {shot ? (
                      <div className="ir-shot">
                        <img src={shot} alt="Captured screen" />
                        <div className="ir-shot-acts">
                          {/* Markup and re-capture are full-screen flows — hide
                            * the form so it's out of the way (and out of the
                            * shot); each flow reopens it when done. */}
                          <button className="ghost-btn" onClick={() => { setOpen(false); setMarking(true); }}><Svg d={Ic.edit} /> Mark it up</button>
                          <button className="ghost-btn" onClick={() => { setOpen(false); start(); }} disabled={busy || recording}><Svg d={Ic.camera} /> Re-capture</button>
                        </div>
                      </div>
                    ) : (
                      <div className="ir-shot ir-shot-none">
                        <button className="ghost-btn" onClick={() => { setOpen(false); start(); }} disabled={busy || recording}><Svg d={Ic.camera} /> Try capturing again</button>
                      </div>
                    )}
                  </div>
                  {/* Details */}
                  <div className="field">
                    <span className="ir-lbl">What's wrong (or what should be better)?</span>
                    <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
                      placeholder="Short summary (e.g. Invoice totals are wrong on the Billing page)" />
                  </div>
                  <div className="field">
                    <span className="ir-lbl">Notes</span>
                    <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                      placeholder="What happened, what you expected, anything you tried…" />
                  </div>
                  {/* Video */}
                  <div className="field">
                    <span className="ir-lbl">Show it on video <em className="sub2">optional · captures your screen and microphone so you can talk through it</em></span>
                    {recording ? (
                      <div className="ir-rec">
                        <span className="ir-rec-dot" />
                        <b>{mmss(recSecs)}</b> recording your screen…
                        <button className="btn-primary2" onClick={stopRecording}><Svg d={Ic.check} /> Stop &amp; attach</button>
                      </div>
                    ) : videoBlob ? (
                      <div className="ir-rec">
                        <video src={videoUrl} controls style={{ maxWidth: "100%", borderRadius: 10, maxHeight: 160 }} />
                        <button className="link-btn" onClick={() => { setVideoBlob(null); setVideoUrl(null); }}>Discard video</button>
                      </div>
                    ) : canRecord ? (
                      <button className="ghost-btn" onClick={recordFromForm} disabled={busy}><Svg d={Ic.camera} /> Record my screen (up to 5 min)</button>
                    ) : (
                      <span className="sub2">This browser can't record the screen — the screenshot and notes still go through.</span>
                    )}
                  </div>
                </div>
                <div className="modal-foot">
                  <button className="btn-ghost2" onClick={() => setOpen(false)} disabled={busy || recording}>Cancel</button>
                  <button className="btn-primary2" onClick={submit} disabled={busy || recording}>
                    {busy ? "Sending…" : "Send annotation"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}

      {marking && shot && createPortal(
        <PhotoMarkup
          imageUrl={shot}
          saving={false}
          onClose={() => { setMarking(false); setOpen(true); }}
          onSave={(blob) => {
            shotBlobRef.current = blob;   // keep the real bytes — the preview URL is a blob: URL
            const url = URL.createObjectURL(blob);
            setShot(url);
            setMarking(false);
            setOpen(true);
            showToast?.("Screenshot marked up.");
          }}
        />,
        document.body
      )}
    </>
  );
}

/* dataURL → Blob (PhotoMarkup hands back a blob; html-to-image gives a URL) */
function blobFromDataUrl(dataUrl) {
  const [head, b64] = dataUrl.split(",");
  const mime = /:(.*?);/.exec(head)?.[1] || "image/jpeg";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/* tickets bucket, unguessable-path convention (same posture as the kit:
   single-tenant CRM, so no per-workspace prefix — the random suffix is the
   unguessability). */
async function upload(blob, ext) {
  const path = `issue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from("tickets").upload(path, blob, {
    contentType: blob.type, upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from("tickets").getPublicUrl(path);
  return data.publicUrl;
}
