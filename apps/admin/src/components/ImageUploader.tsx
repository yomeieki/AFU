import { useRef, useState } from 'react'
import { uploadImage } from '../api/admin'

interface SingleProps {
  mode?: 'single'
  value: string
  onChange: (url: string) => void
}

interface MultiProps {
  mode: 'multi'
  value: string[]
  onChange: (urls: string[]) => void
  max?: number
}

type Props = SingleProps | MultiProps

/**
 * 图片上传组件：调 /api/admin/upload，支持单图（封面/图标）与多图（商品详情轮播）两种模式。
 */
export default function ImageUploader(props: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  const isMulti = props.mode === 'multi'
  const urls: string[] = isMulti ? props.value : props.value ? [props.value] : []
  const max = isMulti ? (props.max ?? 9) : 1
  const canAdd = urls.length < max

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setError('')
    setUploading(true)
    try {
      const remaining = max - urls.length
      const selected = Array.from(files).slice(0, remaining)
      const uploaded: string[] = []
      for (const file of selected) {
        const res = await uploadImage(file)
        uploaded.push(res.data.data.url)
      }
      if (isMulti) {
        props.onChange([...props.value, ...uploaded])
      } else {
        props.onChange(uploaded[0])
      }
    } catch (err: unknown) {
      setError(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '上传失败'
      )
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const handleRemove = (index: number) => {
    if (isMulti) {
      props.onChange(props.value.filter((_, i) => i !== index))
    } else {
      props.onChange('')
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {urls.map((url, i) => (
          <div key={`${url}-${i}`} className="relative w-20 h-20 group">
            <img
              src={url}
              alt=""
              className="w-20 h-20 object-cover rounded-md border border-gray-200"
            />
            <button
              type="button"
              onClick={() => handleRemove(i)}
              className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full text-xs leading-none hidden group-hover:flex items-center justify-center"
              title="移除"
            >
              ×
            </button>
          </div>
        ))}
        {canAdd && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="w-20 h-20 border-2 border-dashed border-gray-300 rounded-md text-gray-400 hover:border-brand-400 hover:text-brand-500 text-xs flex flex-col items-center justify-center disabled:opacity-50"
          >
            <span className="text-xl leading-none mb-1">+</span>
            {uploading ? '上传中...' : '上传图片'}
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple={isMulti}
        onChange={(e) => handleFiles(e.target.files)}
        className="hidden"
      />
      {error && <p className="text-red-500 text-xs mt-1">{error}</p>}
    </div>
  )
}
