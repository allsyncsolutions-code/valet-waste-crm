/* =====================================================================
 * AllSync — Photo Markup editor (web)
 * ---------------------------------------------------------------------
 * CompanyCam-style annotation on any job photo, straight in the browser —
 * no WebView needed on the web, it's a plain canvas. Same toolset the
 * mobile editor ships: freehand pen, arrows, text labels, five colors,
 * undo, clear. Save flattens to a JPEG Blob for the caller to upload
 * (PhotosModule lands it as an "Annotated copy" note on the same job,
 * carrying the original's before/after phase).
 *
 * The photo loads from its signed URL (CORS-clean — Supabase Storage
 * serves ACAO:*, so canvas export is never tainted) and is downscaled
 * to a 1600px editing surface before the first stroke.
 * ===================================================================== */
import { useEffect, useRef, useState } from "react";

const COLORS = ["#ff3b30", "#ffcc00", "#0a84ff", "#ffffff", "#111111"];
const MAXDIM = 1600;
const MAX_UNDO = 15;

export default function PhotoMarkup({ imageUrl, onClose, onSave, saving }) {
  const canvasRef = useRef(null);
  const [tool, setTool] = useState("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState("");
  const [textAt, setTextAt] = useState(null);   // { cx, cy, px, py } canvas + screen coords
  const [textVal, setTextVal] = useState("");
  const [hasInk, setHasInk] = useState(false);
  const undoRef = useRef([]);
  const baseRef = useRef(null);                 // downscaled base Image
  const strokeRef = useRef({ drawing: false, start: null, snap: null });

  /* Load + downscale the base image once. */
  useEffect(() => {
    if (!imageUrl) return undefined;
    let alive = true;
    setReady(false);
    setErr("");
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => {
      if (!alive) return;
      const sc = Math.min(1, MAXDIM / Math.max(im.width, im.height));
      const cv = canvasRef.current;
      cv.width = Math.round(im.width * sc);
      cv.height = Math.round(im.height * sc);
      const cx = cv.getContext("2d");
      cx.drawImage(im, 0, 0, cv.width, cv.height);
      baseRef.current = im;
      undoRef.current = [];
      setHasInk(false);
      setReady(true);
    };
    im.onerror = () => { if (alive) setErr("Could not load the photo for editing."); };
    im.src = imageUrl;
    return () => { alive = false; };
  }, [imageUrl]);

  /* Escape closes (when not typing in the text box). */
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toCanvas = (e) => {
    const cv = canvasRef.current, r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) };
  };

  const drawLine = (cx, a, b, w, col) => {
    cx.strokeStyle = col; cx.lineWidth = w; cx.lineCap = "round"; cx.lineJoin = "round";
    cx.beginPath(); cx.moveTo(a.x, a.y); cx.lineTo(b.x, b.y); cx.stroke();
  };
  const drawArrowShape = (cx, a, b, w, col) => {
    const ang = Math.atan2(b.y - a.y, b.x - a.x), h = w * 3.2;
    cx.strokeStyle = col; cx.fillStyle = col; cx.lineWidth = w; cx.lineCap = "round";
    cx.beginPath(); cx.moveTo(a.x, a.y); cx.lineTo(b.x, b.y); cx.stroke();
    cx.beginPath(); cx.moveTo(b.x, b.y);
    cx.lineTo(b.x - h * Math.cos(ang - 0.42), b.y - h * Math.sin(ang - 0.42));
    cx.lineTo(b.x - h * Math.cos(ang + 0.42), b.y - h * Math.sin(ang + 0.42));
    cx.closePath(); cx.fill();
  };
  const drawTextShape = (cx, cv, p, txt, col) => {
    const fs = Math.round(cv.width / 22);
    cx.font = `700 ${fs}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
    cx.textBaseline = "top";
    const w = cx.measureText(txt).width, pad = fs * 0.35;
    cx.fillStyle = "rgba(0,0,0,.55)";
    cx.fillRect(p.x - pad, p.y - pad, w + pad * 2, fs + pad * 2);
    cx.fillStyle = col;
    cx.fillText(txt, p.x, p.y);
  };
  const lineW = () => Math.max(3, Math.round((canvasRef.current?.width || 1200) / 220));

  const pushUndo = () => {
    const cv = canvasRef.current;
    undoRef.current.push(cv.toDataURL("image/jpeg", 0.85));
    if (undoRef.current.length > MAX_UNDO) undoRef.current.shift();
    setHasInk(true);
  };
  const restore = (url) => new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const cv = canvasRef.current, cx = cv.getContext("2d");
      cx.drawImage(im, 0, 0);
      resolve();
    };
    im.src = url;
  });
  const redrawBase = () => {
    const cv = canvasRef.current, cx = cv.getContext("2d");
    cx.clearRect(0, 0, cv.width, cv.height);
    if (baseRef.current) cx.drawImage(baseRef.current, 0, 0, cv.width, cv.height);
  };

  const onPointerDown = (e) => {
    if (!ready || saving) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = toCanvas(e);
    if (tool === "text") {
      setTextAt({ cx: p.x, cy: p.y, px: e.clientX, py: e.clientY });
      setTextVal("");
      return;
    }
    const st = strokeRef.current;
    st.drawing = true;
    st.start = p;
    pushUndo();
    if (tool === "pen") drawLine(e.currentTarget.getContext("2d"), p, p, lineW(), color);
    else st.snap = e.currentTarget.toDataURL("image/jpeg", 0.85);
  };
  const onPointerMove = (e) => {
    const st = strokeRef.current;
    if (!st.drawing) return;
    e.preventDefault();
    const p = toCanvas(e), cv = e.currentTarget, cx = cv.getContext("2d");
    if (tool === "pen") { drawLine(cx, st.start, p, lineW(), color); st.start = p; }
    else if (tool === "arrow") restore(st.snap).then(() => drawArrowShape(cx, st.start, p, lineW(), color));
  };
  const onPointerUp = (e) => {
    const st = strokeRef.current;
    if (!st.drawing) return;
    st.drawing = false;
    if (tool === "arrow") {
      const p = toCanvas(e), cx = e.currentTarget.getContext("2d");
      restore(st.snap).then(() => drawArrowShape(cx, st.start, p, lineW(), color));
    }
  };

  const placeText = () => {
    const txt = textVal.trim();
    if (txt && textAt) {
      const cv = canvasRef.current;
      pushUndo();
      drawTextShape(cv.getContext("2d"), cv, { x: textAt.cx, y: textAt.cy }, txt, color);
    }
    setTextAt(null);
    setTextVal("");
  };

  const undo = () => {
    const u = undoRef.current.pop();
    if (u) restore(u);
  };
  const clearAll = () => {
    pushUndo();
    redrawBase();
  };

  const save = () => {
    canvasRef.current?.toBlob((blob) => {
      if (blob) onSave?.(blob);
      else setErr("Couldn't flatten the edited photo — try again.");
    }, "image/jpeg", 0.92);
  };

  const btn = (on, extra) => ({
    border: 0, borderRadius: 8, padding: "8px 12px", fontSize: 13, fontWeight: 600,
    cursor: "pointer", background: on ? "#2f6fed" : "#1f2c3a", color: on ? "#fff" : "#dfe8f0",
    ...extra,
  });

  return (
    <div className="modal-scrim" style={{ background: "rgba(0,0,0,.9)" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        display: "flex", flexDirection: "column", width: "96vw", height: "94vh",
        background: "#000", borderRadius: 12, overflow: "hidden",
      }}>
        {/* toolbar */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 12px", background: "#111820", flexWrap: "wrap" }}>
          <button type="button" style={btn(tool === "pen")} onClick={() => setTool("pen")}>Pen</button>
          <button type="button" style={btn(tool === "arrow")} onClick={() => setTool("arrow")}>Arrow</button>
          <button type="button" style={btn(tool === "text")} onClick={() => setTool("text")}>Text</button>
          <button type="button" style={btn(false)} onClick={undo}>Undo</button>
          <button type="button" style={btn(false)} onClick={clearAll}>Clear</button>
          <span style={{ flex: 1 }} />
          {COLORS.map((c) => (
            <button key={c} type="button" onClick={() => setColor(c)} aria-label={`color ${c}`}
              style={{
                width: 26, height: 26, borderRadius: 13, cursor: "pointer", padding: 0,
                background: c, border: color === c ? "2px solid #fff" : "2px solid transparent",
              }} />
          ))}
          <span style={{ flex: 1 }} />
          <button type="button" style={btn(false)} onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" style={btn(true)} onClick={save} disabled={!ready || saving}>
            {saving ? "Saving…" : "Save annotated copy"}
          </button>
        </div>

        {/* canvas */}
        <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          {!ready && !err && <p style={{ color: "rgba(255,255,255,.6)" }}>Loading photo…</p>}
          {err && (
            <div style={{ textAlign: "center" }}>
              <p style={{ color: "#ff9d9d" }}>{err}</p>
              <button type="button" style={btn(false)} onClick={onClose}>Close</button>
            </div>
          )}
          <canvas ref={canvasRef}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            style={{
              maxWidth: "100%", maxHeight: "100%", touchAction: "none",
              cursor: tool === "text" ? "text" : "crosshair", display: ready ? "block" : "none",
            }} />
          {ready && !hasInk && !textAt && (
            <p style={{
              position: "absolute", top: 12, left: 0, right: 0, textAlign: "center",
              color: "rgba(255,255,255,.5)", fontSize: 12, pointerEvents: "none",
            }}>
              Draw on the photo — pen, arrows, text. Save adds an annotated copy to the appointment.
            </p>
          )}
          {textAt && (
            <div style={{
              position: "fixed", left: Math.min(textAt.px, window.innerWidth - 280), top: Math.max(64, textAt.py - 80),
              display: "flex", gap: 6, alignItems: "center", background: "#fff",
              borderRadius: 10, padding: 8, zIndex: 10, boxShadow: "0 8px 24px rgba(0,0,0,.4)",
            }}>
              <input autoFocus value={textVal} onChange={(e) => setTextVal(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") placeText(); if (e.key === "Escape") { setTextAt(null); setTextVal(""); } }}
                placeholder="Label this…"
                style={{ border: 0, outline: "none", fontSize: 15, padding: 6, minWidth: 170 }} />
              <button type="button" onClick={placeText}
                style={{ border: 0, borderRadius: 7, padding: "8px 12px", fontWeight: 700, cursor: "pointer", background: "#2f6fed", color: "#fff" }}>
                Place
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
