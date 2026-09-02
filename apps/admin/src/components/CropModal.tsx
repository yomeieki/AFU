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
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, outW, outH)
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
        <p className="text-xs text-gray-500">拖动图片调整位置，滑块缩放；框内区域即最终显示区域（比例 {aspect.toFixed(2)}:1）。</p>
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
            />
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          缩放
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="flex-1 accent-brand-500"
          />
        </div>
      </div>
    </Modal>
  )
}
