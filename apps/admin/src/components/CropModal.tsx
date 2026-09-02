import { useCallback, useEffect, useState } from 'react'
import Cropper, { Area } from 'react-easy-crop'
import Modal from './ui/Modal'
import Button from './ui/Button'

interface Props {
  file: File
  /** 宽/高 比例，如 2.5 = 750×300 */
  aspect: number
  /** 输出宽度（px），高度按 aspect 推算 */
  outputWidth?: number
  onCancel: () => void
  onDone: (file: File) => void
}

const MIN_ZOOM = 0.4
const MAX_ZOOM = 3

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

async function cropToFile(src: string, area: Area, outW: number, outH: number, name: string): Promise<File> {
  const img = await loadImage(src)
  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unsupported')
  // 允许缩小到比裁剪框还小（整张图都要露出来）：框外空白填白
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, outW, outH)
  const sx = Math.max(0, area.x)
  const sy = Math.max(0, area.y)
  const sw = Math.min(img.naturalWidth - sx, area.width - (sx - area.x))
  const sh = Math.min(img.naturalHeight - sy, area.height - (sy - area.y))
  const scale = outW / area.width
  ctx.drawImage(img, sx, sy, sw, sh, (sx - area.x) * scale, (sy - area.y) * scale, sw * scale, sh * scale)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
  if (!blob) throw new Error('导出失败')
  return new File([blob], name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
}

/**
 * 固定比例裁剪：默认居中铺满，员工可拖动/缩放；输出固定尺寸 JPEG，保证轮播图在小程序里饱满、不溢出。
 */
export default function CropModal({ file, aspect, outputWidth = 1500, onCancel, onDone }: Props) {
  const [src, setSrc] = useState<string>('')
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [area, setArea] = useState<Area | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    readAsDataUrl(file)
      .then((d) => alive && setSrc(d))
      .catch(() => onCancel())
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])

  const onCropComplete = useCallback((_: Area, pixels: Area) => setArea(pixels), [])

  const handleDone = async () => {
    if (!area || busy) return
    setBusy(true)
    try {
      const outH = Math.round(outputWidth / aspect)
      onDone(await cropToFile(src, area, outputWidth, outH, file.name))
    } catch {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="裁剪图片"
      width="md"
      closeOnOverlay={false}
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button onClick={handleDone} loading={busy} disabled={!area}>
            {busy ? '处理中...' : '确定裁剪'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-gray-500">
          拖动图片调整位置，滑块或 − / + 缩放（可以缩小到整张图都露出来，空白处补白）；框内区域即首页轮播最终显示区域（宽高 {aspect.toFixed(1)}:1）。
        </p>
        <div className="relative w-full bg-gray-900 rounded-md overflow-hidden" style={{ height: 'min(52vh, 360px)' }}>
          {src && (
            <Cropper
              image={src}
              crop={crop}
              zoom={zoom}
              aspect={aspect}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
              objectFit="cover"
              minZoom={MIN_ZOOM}
              maxZoom={MAX_ZOOM}
              restrictPosition={false}
              zoomSpeed={0.3}
            />
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          缩放
          <button type="button" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, +(z - 0.1).toFixed(2)))} className="w-7 h-7 rounded border border-gray-300 text-base leading-none hover:bg-gray-50">−</button>
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="flex-1 accent-brand-500"
          />
          <button type="button" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, +(z + 0.1).toFixed(2)))} className="w-7 h-7 rounded border border-gray-300 text-base leading-none hover:bg-gray-50">+</button>
          <button type="button" onClick={() => { setZoom(1); setCrop({ x: 0, y: 0 }) }} className="px-2 h-7 rounded border border-gray-300 hover:bg-gray-50">铺满</button>
        </div>
      </div>
    </Modal>
  )
}
