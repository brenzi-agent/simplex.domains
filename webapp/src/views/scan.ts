// The camera reading a link's QR code, as the app's own scan does: the platform's detector where it has one, else jsQR.
import { el } from "../dom.ts"
import { readQr } from "../scan.ts"
import { onPageLeft } from "./shell.ts"

interface Detector { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> }
interface DetectorClass { new (options: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> }
type Reader = (video: HTMLVideoElement) => Promise<string | null>

const QR_FORMAT = "qr_code"
// a frame is read this often, which jsQR keeps up with on a phone at the width below
const READ_EVERY_MS = 200
// the widest frame jsQR is given: a link's QR fills much of the view, so a camera's full frame only slows it
const READ_WIDTH = 640
const SCAN_TITLE_ID = "scan-title"

let cameras: Promise<boolean> | null = null
// the browser lists the kinds of devices without asking for the camera, so the button shows only where one is
export function hasCamera(): Promise<boolean> {
  cameras ??= navigator.mediaDevices?.enumerateDevices
    ? navigator.mediaDevices.enumerateDevices().then((devices) => devices.some((d) => d.kind === "videoinput"), () => false)
    : Promise.resolve(false)
  return cameras
}

async function nativeReader(): Promise<Reader | null> {
  const Native = (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector
  if (!Native || !(await Native.getSupportedFormats().catch((): string[] => [])).includes(QR_FORMAT)) return null
  const detector = new Native({ formats: [QR_FORMAT] })
  return async (video) => (await detector.detect(video))[0]?.rawValue ?? null
}

function pixelReader(): Reader {
  const canvas = el("canvas", {})
  const context = canvas.getContext("2d", { willReadFrequently: true })!
  return (video) => {
    if (!video.videoWidth) return Promise.resolve(null)
    const scale = Math.min(1, READ_WIDTH / video.videoWidth)
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    return readQr(context.getImageData(0, 0, canvas.width, canvas.height))
  }
}

let shown: HTMLDialogElement | null = null
onPageLeft(() => shown?.close())

// Shows the rear camera over the page until it reads a QR code, resolving with its text, or with null once closed.
// A camera refused, missing or busy rejects with the browser's DOMException.
export async function scanQr(): Promise<string | null> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
  const read = await nativeReader() ?? pixelReader()
  const video = el("video", { playsinline: true, "aria-hidden": "true" })
  video.muted = true
  video.srcObject = stream
  const dialog = el("dialog", { class: "modal", "aria-labelledby": SCAN_TITLE_ID })
  const close = () => dialog.close()
  dialog.append(el("div", { class: "modal-backdrop", onclick: close }),
    el("div", { class: "pop scan-pop" },
      el("h2", { id: SCAN_TITLE_ID }, "Scan a QR code"),
      el("p", { class: "soft" }, "Point the camera at the QR code of your SimpleX address or channel link."),
      video,
      el("button", { class: "text-link", type: "button", onclick: close }, "Cancel")))
  return new Promise((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (text: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      for (const track of stream.getTracks()) track.stop()
      shown = null
      if (dialog.open) dialog.close()
      dialog.remove()
      resolve(text)
    }
    dialog.addEventListener("close", () => finish(null))
    const look = async () => {
      const text = await read(video).catch(() => null)
      if (done) return
      if (text) return finish(text)
      timer = setTimeout(() => void look(), READ_EVERY_MS)
    }
    document.body.append(dialog)
    dialog.showModal()
    shown = dialog
    // a play cut short by Cancel rejects, with nothing left to show
    void video.play().catch(() => undefined)
    void look()
  })
}
